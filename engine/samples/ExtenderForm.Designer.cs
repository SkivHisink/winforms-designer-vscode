namespace WinFormsDesigner.Samples
{
    // Fixture for extender providers: the components container + a ToolTip created with it + a SetToolTip
    // extended-property assignment. The interpreter recognizes the container, the provider ctor
    // new ToolTip(this.components), and provider.SetToolTip(target, value) — so the form is representable
    // and the tooltip is wired. (ToolTip has no icon → no BinaryFormatter, unlike ErrorProvider.)
    partial class ExtenderForm
    {
        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.toolTip1 = new System.Windows.Forms.ToolTip(this.components);
            this.helpButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            this.helpButton.Location = new System.Drawing.Point(40, 40);
            this.helpButton.Name = "helpButton";
            this.helpButton.Size = new System.Drawing.Size(120, 30);
            this.helpButton.Text = "Help";
            this.toolTip1.SetToolTip(this.helpButton, "Click for help");
            this.Controls.Add(this.helpButton);
            this.ClientSize = new System.Drawing.Size(300, 140);
            this.Name = "ExtenderForm";
            this.Text = "ExtenderForm";
            this.ResumeLayout(false);
        }

        private System.ComponentModel.IContainer components;
        private System.Windows.Forms.ToolTip toolTip1;
        private System.Windows.Forms.Button helpButton;
    }
}
