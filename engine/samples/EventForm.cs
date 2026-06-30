using System;
using System.Windows.Forms;

namespace WinFormsDesigner.Samples
{
    // Code-behind partner for EventForm.Designer.cs. Open THIS file to get the designer (VS-style); the
    // Events tab lists the wirings from the .Designer.cs, and double-clicking a wired event navigates here,
    // placing the caret inside the matching handler body. (Excluded from compilation via samples/** — this
    // is a designer fixture, not built code.)
    public partial class EventForm : Form
    {
        public EventForm()
        {
            InitializeComponent();
        }

        private void okButton_Click(object sender, EventArgs e)
        {
        }

        private void okButton_MouseEnter(object sender, EventArgs e)
        {
        }

        private void EventForm_Load(object sender, EventArgs e)
        {
        }
    }
}
