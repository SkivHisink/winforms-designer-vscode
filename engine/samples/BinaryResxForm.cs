using System.Windows.Forms;

namespace SampleApp
{
    // Code-behind for the S3 binary-resx fixture. Plain Form so the slice tests ONLY binary-resx detection
    // (not inheritance): DetectRootType resolves : Form → inheritedBase=false, and the banner is driven purely by
    // the sibling .resx's BinaryFormatter ImageStream node.
    public partial class BinaryResxForm : Form
    {
        public BinaryResxForm()
        {
            InitializeComponent();
        }
    }
}
