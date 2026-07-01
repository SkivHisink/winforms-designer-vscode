namespace SampleApp
{
    partial class SplitterForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.SplitContainer splitContainer1;
        private System.Windows.Forms.Button leftButton;
        private System.Windows.Forms.Label rightLabel;

        private void InitializeComponent()
        {
            this.splitContainer1 = new System.Windows.Forms.SplitContainer();
            this.leftButton = new System.Windows.Forms.Button();
            this.rightLabel = new System.Windows.Forms.Label();
            ((System.ComponentModel.ISupportInitialize)(this.splitContainer1)).BeginInit();
            this.splitContainer1.SuspendLayout();
            this.SuspendLayout();
            //
            // splitContainer1
            //
            this.splitContainer1.Location = new System.Drawing.Point(12, 12);
            this.splitContainer1.Name = "splitContainer1";
            this.splitContainer1.Panel1.Controls.Add(this.leftButton);
            this.splitContainer1.Panel2.Controls.Add(this.rightLabel);
            this.splitContainer1.Size = new System.Drawing.Size(400, 200);
            this.splitContainer1.SplitterDistance = 120;
            this.splitContainer1.TabIndex = 0;
            //
            // leftButton
            //
            this.leftButton.Location = new System.Drawing.Point(10, 10);
            this.leftButton.Name = "leftButton";
            this.leftButton.Size = new System.Drawing.Size(80, 30);
            this.leftButton.Text = "Left";
            //
            // rightLabel
            //
            this.rightLabel.AutoSize = true;
            this.rightLabel.Location = new System.Drawing.Point(10, 10);
            this.rightLabel.Name = "rightLabel";
            this.rightLabel.Text = "Right panel";
            //
            // SplitterForm
            //
            this.ClientSize = new System.Drawing.Size(424, 224);
            this.Controls.Add(this.splitContainer1);
            this.Name = "SplitterForm";
            this.Text = "Splitter Form";
            ((System.ComponentModel.ISupportInitialize)(this.splitContainer1)).EndInit();
            this.splitContainer1.ResumeLayout(false);
            this.ResumeLayout(false);
        }
    }
}
