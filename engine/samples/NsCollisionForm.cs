namespace Decoy
{
    // codex R#4 regression DECOY: a same-SHORT-name class in ANOTHER namespace with a framework base. The classifier
    // must NOT pick this one when classifying SampleApp.NsCollisionForm (which is genuinely inherited). Before the fix
    // the sibling lookup matched by short name only and could select this decoy → false-resolved the real form.
    public partial class NsCollisionForm : System.Windows.Forms.Form
    {
    }
}

namespace SampleApp
{
    public partial class NsCollisionForm : InheritedBaseForm
    {
        public NsCollisionForm()
        {
            InitializeComponent();
        }
    }
}
