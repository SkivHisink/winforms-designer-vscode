namespace SampleApp
{
    partial class FlowForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.FlowLayoutPanel flowLayoutPanel1;
        private System.Windows.Forms.Button btnA;
        private System.Windows.Forms.Button btnB;
        private System.Windows.Forms.Button btnC;

        private void InitializeComponent()
        {
            this.flowLayoutPanel1 = new System.Windows.Forms.FlowLayoutPanel();
            this.btnA = new System.Windows.Forms.Button();
            this.btnB = new System.Windows.Forms.Button();
            this.btnC = new System.Windows.Forms.Button();
            this.flowLayoutPanel1.SuspendLayout();
            this.SuspendLayout();
            //
            // flowLayoutPanel1
            //
            this.flowLayoutPanel1.Controls.Add(this.btnA);
            this.flowLayoutPanel1.Controls.Add(this.btnB);
            this.flowLayoutPanel1.Controls.Add(this.btnC);
            this.flowLayoutPanel1.Location = new System.Drawing.Point(12, 12);
            this.flowLayoutPanel1.Name = "flowLayoutPanel1";
            this.flowLayoutPanel1.Size = new System.Drawing.Size(400, 100);
            this.flowLayoutPanel1.TabIndex = 0;
            //
            // btnA
            //
            this.btnA.Name = "btnA";
            this.btnA.Size = new System.Drawing.Size(75, 30);
            this.btnA.Text = "A";
            //
            // btnB
            //
            this.btnB.Name = "btnB";
            this.btnB.Size = new System.Drawing.Size(75, 30);
            this.btnB.Text = "B";
            //
            // btnC
            //
            this.btnC.Name = "btnC";
            this.btnC.Size = new System.Drawing.Size(75, 30);
            this.btnC.Text = "C";
            //
            // FlowForm
            //
            this.ClientSize = new System.Drawing.Size(424, 124);
            this.Controls.Add(this.flowLayoutPanel1);
            this.Name = "FlowForm";
            this.Text = "Flow Form";
            this.flowLayoutPanel1.ResumeLayout(false);
            this.ResumeLayout(false);
        }
    }
}
