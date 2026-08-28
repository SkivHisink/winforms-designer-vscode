using System.Drawing;
using System.Windows.Forms;

namespace VisualStudioReference.Net48
{
    public class S011GenericBaseForm<T> : Form
    {
        protected readonly Label inheritedLabel;

        public S011GenericBaseForm()
        {
            this.inheritedLabel = new Label();
            this.inheritedLabel.AutoSize = true;
            this.inheritedLabel.Location = new Point(34, 34);
            this.inheritedLabel.Name = "inheritedLabel";
            this.inheritedLabel.Text = "Inherited generic base";
            this.Controls.Add(this.inheritedLabel);
        }
    }
}
