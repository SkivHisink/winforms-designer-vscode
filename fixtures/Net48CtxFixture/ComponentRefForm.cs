namespace WinFormsDesigner.Samples
{
    // The companion partial the sample .Designer.cs omits (it is a render fixture, not a compilable form): declares the
    // Form base and a public parameterless ctor so the net48 engine can instantiate WinFormsDesigner.Samples.
    // ComponentRefForm — its AcceptButton/CancelButton (control refs) and okButton.ContextMenuStrip (a component ref)
    // then live on a real compiled instance, so describe self-enumerates the sibling field names for the dropdown and
    // TryApply resolves a picked name back to the live instance. (This sample keeps its own namespace, unlike the
    // SampleApp render samples — the two partial halves only need to agree, which they do here.)
    partial class ComponentRefForm : System.Windows.Forms.Form
    {
        public ComponentRefForm()
        {
            InitializeComponent();
        }
    }
}
