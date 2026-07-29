namespace DevExpressDemo
{
    /// <summary>
    /// A vendor-rooted form: the base type is DevExpress's XtraForm, not System.Windows.Forms.Form, and every
    /// control on it is a real DevExpress control. The designer renders this by instantiating the compiled
    /// vendor types and replaying this form's live .Designer.cs source onto them.
    /// </summary>
    public partial class MainForm : DevExpress.XtraEditors.XtraForm
    {
        public MainForm()
        {
            InitializeComponent();
        }
    }
}
