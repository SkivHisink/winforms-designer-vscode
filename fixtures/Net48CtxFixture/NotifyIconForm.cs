namespace WinFormsDesigner.Samples
{
    // The companion partial the sample .Designer.cs omits (it is a render fixture, not a compilable form): declares the
    // Form base and a public parameterless ctor so the net48 engine can instantiate WinFormsDesigner.Samples.
    // NotifyIconForm — its notifyIcon1.ContextMenuStrip (a TRAY-component → component reference) then lives on a real
    // compiled instance, so describe self-enumerates the ContextMenuStrip field names for the dropdown and TryApply
    // resolves a picked name back to the live component (via the FieldNames reverse-scan; NotifyIcon is not a Control).
    partial class NotifyIconForm : System.Windows.Forms.Form
    {
        public NotifyIconForm()
        {
            InitializeComponent();
        }
    }
}
