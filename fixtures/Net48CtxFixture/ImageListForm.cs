namespace SampleApp
{
    // The companion partial the sample .Designer.cs omits (it is a render fixture, not a compilable form): declares the
    // Form base and a public parameterless ctor so the net48 engine can instantiate SampleApp.ImageListForm — its real
    // ImageList (Images.Add) then holds the keyed images, so describe's context-aware ImageKeyConverter enumerates them.
    partial class ImageListForm : System.Windows.Forms.Form
    {
        public ImageListForm()
        {
            InitializeComponent();
        }
    }
}
