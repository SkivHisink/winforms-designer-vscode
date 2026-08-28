namespace SampleApp
{
    partial class S051EventRevisionForm
    {
        private System.Windows.Forms.TextBox textBox1;

        private void InitializeComponent()
        {
            this.textBox1 = new System.Windows.Forms.TextBox();
            this.SuspendLayout();
            this.textBox1.Location = new System.Drawing.Point(24, 32);
            this.textBox1.Name = "textBox1";
            this.textBox1.Size = new System.Drawing.Size(180, 23);
            this.textBox1.TextChanged += new System.EventHandler(this.textBox1_TextChanged);
            this.ClientSize = new System.Drawing.Size(280, 140);
            this.Controls.Add(this.textBox1);
            this.Name = "S051EventRevisionForm";
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
