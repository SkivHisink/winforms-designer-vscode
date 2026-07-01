namespace SampleApp
{
    partial class AnchorDockForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.Panel panel1;
        private System.Windows.Forms.Button btn2;

        private void InitializeComponent()
        {
            this.panel1 = new System.Windows.Forms.Panel();
            this.btn2 = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // panel1
            //
            this.panel1.Location = new System.Drawing.Point(12, 12);
            this.panel1.Name = "panel1";
            this.panel1.Size = new System.Drawing.Size(200, 100);
            this.panel1.TabIndex = 0;
            this.panel1.Anchor = ((System.Windows.Forms.AnchorStyles)(((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Bottom)
                | System.Windows.Forms.AnchorStyles.Left)
                | System.Windows.Forms.AnchorStyles.Right));
            this.panel1.Padding = new System.Windows.Forms.Padding(4);
            //
            // btn2
            //
            this.btn2.Location = new System.Drawing.Point(230, 12);
            this.btn2.Name = "btn2";
            this.btn2.Size = new System.Drawing.Size(90, 30);
            this.btn2.TabIndex = 1;
            this.btn2.Text = "btn2";
            this.btn2.Dock = System.Windows.Forms.DockStyle.Right;
            this.btn2.Anchor = ((System.Windows.Forms.AnchorStyles)(System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left));
            //
            // AnchorDockForm
            //
            this.ClientSize = new System.Drawing.Size(400, 300);
            this.Controls.Add(this.panel1);
            this.Controls.Add(this.btn2);
            this.Name = "AnchorDockForm";
            this.Text = "Anchor / Dock Form";
            this.ResumeLayout(false);
        }
    }
}
