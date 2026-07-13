namespace SampleApp
{
    partial class QualifiedForm
    {
        private System.Windows.Forms.Button plainButton;

        private void InitializeComponent()
        {
            this.plainButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // plainButton
            //
            this.plainButton.Location = new System.Drawing.Point(24, 24);
            this.plainButton.Name = "plainButton";
            this.plainButton.Size = new System.Drawing.Size(140, 30);
            this.plainButton.Text = "Plain framework form";
            //
            // QualifiedForm
            //
            this.ClientSize = new System.Drawing.Size(320, 140);
            this.Controls.Add(this.plainButton);
            this.Name = "QualifiedForm";
            this.Text = "Qualified Form";
            this.ResumeLayout(false);
        }
    }
}
