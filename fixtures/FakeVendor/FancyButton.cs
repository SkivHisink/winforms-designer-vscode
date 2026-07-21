using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;

namespace FakeVendor
{
    // Mimics a DevExpress-style control with an "Appearance" SUB-OBJECT: a settable value graph the designer writes
    // via a property CHAIN (this.fancyButton1.Appearance.BorderColor = ...). The interpreter must walk the chain
    // through TypeDescriptor: read Appearance (non-null, initialized in the ctor), then set BorderColor on it.
    public sealed class FakeAppearance
    {
        public Color BorderColor { get; set; } = Color.Empty;
        public int BorderWidth { get; set; } = 1;
    }

    public class FancyButton : Button
    {
        public FancyButton() { Appearance = new FakeAppearance(); }

        // A public, non-null sub-object property — the property-chain target. Not serialized as a value; the designer
        // sets its members individually (exactly the DevExpress Appearance/Options pattern).
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
        public FakeAppearance Appearance { get; }
    }
}
