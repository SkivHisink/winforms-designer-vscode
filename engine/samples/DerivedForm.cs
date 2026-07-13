namespace SampleApp
{
    // Visual-inheritance DERIVED form (0.10.0 S2). Its base is a user type (InheritedBaseForm), NOT a framework
    // Form/UserControl — so the net9 interpreter can't reproduce the base's controls and renders a best-effort
    // preview with only derivedButton. DetectRootType flags this (inheritedBase=true, baseName=InheritedBaseForm)
    // and the host shows an honest "preview may be incomplete" banner. net48 renders both buttons correctly.
    public partial class DerivedForm : InheritedBaseForm
    {
        public DerivedForm()
        {
            InitializeComponent();
        }
    }
}
