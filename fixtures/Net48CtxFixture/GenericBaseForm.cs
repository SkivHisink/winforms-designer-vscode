using System.Drawing;
using System.Windows.Forms;

namespace SampleApp
{
    public class GenericBaseForm<T> : Form
    {
        protected readonly Button baseButton;
        protected readonly Panel basePanel;
        private readonly Label privateInheritedLabel;
        private readonly Button privateInheritedButton;

        public GenericBaseForm()
        {
            baseButton = new Button
            {
                Location = new Point(12, 12),
                Name = "baseButton",
                Size = new Size(90, 23),
                Text = typeof(T).Name
            };
            basePanel = new Panel
            {
                BorderStyle = BorderStyle.FixedSingle,
                Location = new Point(126, 12),
                Name = "basePanel",
                Size = new Size(118, 42)
            };
            privateInheritedLabel = new Label
            {
                AutoSize = true,
                Location = new Point(126, 62),
                Name = "privateInheritedLabel",
                Text = "Private base label"
            };
            privateInheritedButton = new Button
            {
                Location = new Point(126, 86),
                Name = "privateInheritedButton",
                Size = new Size(118, 23),
                Text = "Private base button"
            };
            Controls.Add(baseButton);
            Controls.Add(basePanel);
            Controls.Add(privateInheritedLabel);
            Controls.Add(privateInheritedButton);
        }
    }
}
