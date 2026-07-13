using System.Windows.Forms;

namespace SampleApp
{
    // Base form for a VISUAL-INHERITANCE fixture (0.10.0 S2). A derived form (DerivedForm : InheritedBaseForm)
    // inherits baseButton through real CLR inheritance. net48 instantiates the real compiled DerivedForm, so
    // baseButton renders; the net9 interpreter replays ONLY the derived .Designer.cs and never sees this base's
    // InitializeComponent, so baseButton is silently dropped → the S2 "inherited base" banner fires (net9-only).
    public partial class InheritedBaseForm : Form
    {
        public InheritedBaseForm()
        {
            InitializeComponent();
        }
    }
}
