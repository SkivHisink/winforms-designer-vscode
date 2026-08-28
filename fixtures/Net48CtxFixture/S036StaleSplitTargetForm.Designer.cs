namespace SampleApp
{
    partial class S036StaleSplitTargetForm
    {
        private System.Windows.Forms.SplitContainer splitContainer1;
        private System.Windows.Forms.Button button1;

        private void InitializeComponent()
        {
            this.splitContainer1 = new System.Windows.Forms.SplitContainer();
            this.button1 = new System.Windows.Forms.Button();
            ((System.ComponentModel.ISupportInitialize)(this.splitContainer1)).BeginInit();
            this.splitContainer1.SuspendLayout();
            this.SuspendLayout();
            this.splitContainer1.Location = new System.Drawing.Point(20, 20);
            this.splitContainer1.Name = "splitContainer1";
            this.splitContainer1.Size = new System.Drawing.Size(240, 140);
            this.splitContainer1.SplitterDistance = 110;
            this.button1.Location = new System.Drawing.Point(300, 80);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(100, 30);
            this.ClientSize = new System.Drawing.Size(440, 200);
            this.Controls.Add(this.button1);
            this.Controls.Add(this.splitContainer1);
            this.Name = "S036StaleSplitTargetForm";
            ((System.ComponentModel.ISupportInitialize)(this.splitContainer1)).EndInit();
            this.splitContainer1.ResumeLayout(false);
            this.ResumeLayout(false);
        }
    }
}
