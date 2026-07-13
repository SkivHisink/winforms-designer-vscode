namespace SampleApp
{
    // Vendor-base reproduction (0.10.0 S2): a form deriving from a DevExpress base (XtraForm). This file is a
    // net9 FALLBACK-only fixture — it is deliberately NOT compiled (samples/**/*.cs is <Compile Remove/>'d, and it
    // is not linked into any build), so the missing DevExpress reference is harmless. The net9 interpreter renders
    // VendorForm.Designer.cs on a best-effort plain-Form surface and reads THIS sibling as text: the base identifier
    // "XtraForm" isn't a framework root, so DetectRootType flags it (inheritedBase=true, baseName=XtraForm). This is
    // the classic silent-mis-render case S2 fixes — the vendor skin/chrome the substring match used to swallow.
    public partial class VendorForm : DevExpress.XtraEditors.XtraForm
    {
        public VendorForm()
        {
            InitializeComponent();
        }
    }
}
