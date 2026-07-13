using U = System.Windows.Forms.UserControl;

namespace SampleApp
{
    // codex R#8 regression: a SAME-FILE `using` alias of a framework root. `: U` must classify as RESOLVED
    // UserControl (NOT flagged inherited) AND pick the UserControl surface. Before the fix SimpleName saw "U",
    // flagged it inherited, and — "U" lacking the "UserControl" substring — mis-rendered it on a Form surface.
    public partial class AliasedUcForm : U
    {
        public AliasedUcForm()
        {
            InitializeComponent();
        }
    }
}
