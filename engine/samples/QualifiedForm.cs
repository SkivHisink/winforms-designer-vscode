namespace SampleApp
{
    // FQN negative fixture (0.10.0 S2): a plain form whose base is written fully-qualified
    // (System.Windows.Forms.Form). It must classify as RESOLVED (inheritedBase=false, NO banner) — proving the
    // classifier normalizes qualified/aliased spellings of the framework roots instead of only bare "Form".
    public partial class QualifiedForm : System.Windows.Forms.Form
    {
        public QualifiedForm()
        {
            InitializeComponent();
        }
    }
}
