using System;
using System.Windows.Forms;

namespace VisualStudioReference.Modern;

public partial class S050ExistingEventForm : Form
{
    public S050ExistingEventForm() => InitializeComponent();

    private void button1_Click(object? sender, EventArgs e)
    {
        this.Text = "Existing Click handler invoked";
    }
}
