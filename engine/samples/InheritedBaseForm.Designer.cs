namespace SampleApp
{
    partial class InheritedBaseForm
    {
        private System.Windows.Forms.Button baseButton;

        private void InitializeComponent()
        {
            this.baseButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // baseButton
            //
            this.baseButton.Location = new System.Drawing.Point(24, 24);
            this.baseButton.Name = "baseButton";
            this.baseButton.Size = new System.Drawing.Size(140, 30);
            this.baseButton.Text = "From base form";
            //
            // InheritedBaseForm
            //
            this.ClientSize = new System.Drawing.Size(320, 200);
            this.Controls.Add(this.baseButton);
            this.Name = "InheritedBaseForm";
            this.Text = "Inherited Base Form";
            this.ResumeLayout(false);
        }
    }
}
