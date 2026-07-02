namespace SampleApp
{
    partial class TabAddRangeForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.TabControl tabControl1;
        private System.Windows.Forms.TabPage tabPageA;
        private System.Windows.Forms.TabPage tabPageB;
        private System.Windows.Forms.TabPage tabPageC;
        private System.Windows.Forms.Button aButton;
        private System.Windows.Forms.Label bLabel;
        private System.Windows.Forms.Button cButton;

        private void InitializeComponent()
        {
            this.tabControl1 = new System.Windows.Forms.TabControl();
            this.tabPageA = new System.Windows.Forms.TabPage();
            this.tabPageB = new System.Windows.Forms.TabPage();
            this.tabPageC = new System.Windows.Forms.TabPage();
            this.aButton = new System.Windows.Forms.Button();
            this.bLabel = new System.Windows.Forms.Label();
            this.cButton = new System.Windows.Forms.Button();
            this.tabControl1.SuspendLayout();
            this.tabPageA.SuspendLayout();
            this.tabPageB.SuspendLayout();
            this.tabPageC.SuspendLayout();
            this.SuspendLayout();
            //
            // tabControl1
            //
            this.tabControl1.TabPages.AddRange(new System.Windows.Forms.TabPage[] {
            this.tabPageA,
            this.tabPageB,
            this.tabPageC});
            this.tabControl1.Location = new System.Drawing.Point(12, 12);
            this.tabControl1.Name = "tabControl1";
            this.tabControl1.SelectedTab = this.tabPageB;
            this.tabControl1.SelectedIndex = 0;
            this.tabControl1.Size = new System.Drawing.Size(400, 200);
            this.tabControl1.TabIndex = 0;
            //
            // tabPageA
            //
            this.tabPageA.Controls.Add(this.aButton);
            this.tabPageA.Location = new System.Drawing.Point(4, 24);
            this.tabPageA.Name = "tabPageA";
            this.tabPageA.Size = new System.Drawing.Size(392, 172);
            this.tabPageA.TabIndex = 0;
            this.tabPageA.Text = "Page A";
            //
            // tabPageB
            //
            this.tabPageB.Controls.Add(this.bLabel);
            this.tabPageB.Location = new System.Drawing.Point(4, 24);
            this.tabPageB.Name = "tabPageB";
            this.tabPageB.Size = new System.Drawing.Size(392, 172);
            this.tabPageB.TabIndex = 1;
            this.tabPageB.Text = "Page B";
            //
            // tabPageC
            //
            this.tabPageC.Controls.Add(this.cButton);
            this.tabPageC.Location = new System.Drawing.Point(4, 24);
            this.tabPageC.Name = "tabPageC";
            this.tabPageC.Size = new System.Drawing.Size(392, 172);
            this.tabPageC.TabIndex = 2;
            this.tabPageC.Text = "Page C";
            //
            // aButton
            //
            this.aButton.Location = new System.Drawing.Point(10, 10);
            this.aButton.Name = "aButton";
            this.aButton.Size = new System.Drawing.Size(80, 30);
            this.aButton.TabIndex = 0;
            this.aButton.Text = "A";
            //
            // bLabel
            //
            this.bLabel.AutoSize = true;
            this.bLabel.Location = new System.Drawing.Point(10, 10);
            this.bLabel.Name = "bLabel";
            this.bLabel.Text = "On Page B";
            //
            // cButton
            //
            this.cButton.Location = new System.Drawing.Point(10, 10);
            this.cButton.Name = "cButton";
            this.cButton.Size = new System.Drawing.Size(80, 30);
            this.cButton.TabIndex = 0;
            this.cButton.Text = "C";
            //
            // TabAddRangeForm
            //
            this.ClientSize = new System.Drawing.Size(424, 224);
            this.Controls.Add(this.tabControl1);
            this.Name = "TabAddRangeForm";
            this.Text = "Tab AddRange Form";
            this.tabControl1.ResumeLayout(false);
            this.tabPageA.ResumeLayout(false);
            this.tabPageB.ResumeLayout(false);
            this.tabPageB.PerformLayout();
            this.tabPageC.ResumeLayout(false);
            this.ResumeLayout(false);
        }
    }
}
