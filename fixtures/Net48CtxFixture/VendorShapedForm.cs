using System.Windows.Forms;

namespace SampleApp
{
    /// <summary>Code-behind half. Its field initializer and Load are the tell: if the preview ever constructs THIS
    /// class instead of replaying the designer file onto the base type, the marker window exists — which is what the
    /// e2e asserts must NOT happen.</summary>
    public partial class VendorShapedForm : Form
    {
        public const string MarkerTitle = "WFD-VENDORSHAPED-MUSTNOTRUN";

        private readonly Form _openedByFieldInitializer = new Form { Text = MarkerTitle, ShowInTaskbar = false };

        public VendorShapedForm()
        {
            InitializeComponent();
            Load += (sender, args) => _openedByFieldInitializer.Show();
        }
    }
}
