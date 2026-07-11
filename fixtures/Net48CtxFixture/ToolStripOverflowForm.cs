namespace SampleApp
{
    // The companion partial the sample .Designer.cs omits (it is a render fixture, not a compilable form): declares
    // the Form base and a public parameterless ctor so the net48 engine can instantiate SampleApp.ToolStripOverflowForm
    // and lay out the ToolStrip (Show pump → real overflow placement), for the cross-runtime overflow parity leg.
    partial class ToolStripOverflowForm : System.Windows.Forms.Form
    {
        public ToolStripOverflowForm()
        {
            InitializeComponent();
        }
    }
}
