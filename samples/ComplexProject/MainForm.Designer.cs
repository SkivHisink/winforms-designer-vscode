namespace ComplexProject
{
    partial class MainForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.Button okButton;

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
            this.SuspendLayout();
            //
            // okButton
            //
            this.okButton.Location = new System.Drawing.Point(20, 20);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(100, 30);
            this.okButton.Text = "OK";
            //
            // MainForm
            //
            this.ClientSize = new System.Drawing.Size(300, 200);
            this.Controls.Add(this.okButton);
            this.Name = "MainForm";
            this.Text = "Complex Project Form";
            this.ResumeLayout(false);
        }
    }
}
