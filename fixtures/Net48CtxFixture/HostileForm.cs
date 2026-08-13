using System.Windows.Forms;

namespace SampleApp
{
    /// <summary>Code-behind half of the fixture: a form whose own Load opens another top-level window — a splash
    /// screen, a docking panel or a "please wait" dialog in a real application. The compiled preview runs this for
    /// real, so it is the honest test of whether such a window can reach the user's screen.</summary>
    public partial class HostileForm : Form
    {
        /// <summary>Title the e2e looks for: the engine must report this window as contained on its private render
        /// desktop, never as something the user has to close.</summary>
        public const string PopupTitle = "WFD-DESIGNTIME-POPUP";

        public HostileForm()
        {
            InitializeComponent();
            Load += (sender, args) =>
            {
                var stray = new Form { Text = PopupTitle, Size = new System.Drawing.Size(320, 200), ShowInTaskbar = false };
                stray.Show();
            };
        }
    }
}
