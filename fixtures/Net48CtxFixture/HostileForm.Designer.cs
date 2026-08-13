namespace SampleApp
{
    /// <summary>
    /// e2e fixture for the "the designer must not put windows on my screen" contract. It reproduces what a real
    /// application's main form does and what the net48 preview used to make visible:
    ///   • WindowState = Maximized — Windows then IGNORES the preview's off-screen Location and its requested
    ///     ClientSize, so the form was realized full-screen ON the user's desktop and captured at monitor size;
    ///   • a Load handler that opens ANOTHER window (see HostileForm.cs) — the preview instantiates the real compiled
    ///     type, so that code really runs, and its window used to appear too.
    /// </summary>
    partial class HostileForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.Button okButton;
        private System.Windows.Forms.Label captionLabel;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        private void InitializeComponent()
        {
            this.okButton = new System.Windows.Forms.Button();
            this.captionLabel = new System.Windows.Forms.Label();
            this.SuspendLayout();
            //
            // okButton
            //
            this.okButton.Location = new System.Drawing.Point(24, 24);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(96, 28);
            this.okButton.TabIndex = 0;
            this.okButton.Text = "OK";
            //
            // captionLabel
            //
            this.captionLabel.AutoSize = true;
            this.captionLabel.Location = new System.Drawing.Point(24, 72);
            this.captionLabel.Name = "captionLabel";
            this.captionLabel.Size = new System.Drawing.Size(120, 15);
            this.captionLabel.TabIndex = 1;
            this.captionLabel.Text = "designed size, please";
            //
            // HostileForm
            //
            this.ClientSize = new System.Drawing.Size(420, 260);
            this.Controls.Add(this.okButton);
            this.Controls.Add(this.captionLabel);
            this.Name = "HostileForm";
            this.Text = "HostileForm";
            this.WindowState = System.Windows.Forms.FormWindowState.Maximized;
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
