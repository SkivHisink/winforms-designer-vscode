namespace VisualStudioReference.Net48
{
    partial class S051EventRevisionForm
    {
        private System.Windows.Forms.TextBox textBox1;

        private void InitializeComponent()
        {
            this.textBox1 = new System.Windows.Forms.TextBox();
            this.SuspendLayout();
            //
            // textBox1
            //
            this.textBox1.Location = new System.Drawing.Point(24, 32);
            this.textBox1.Name = "textBox1";
            this.textBox1.Size = new System.Drawing.Size(180, 20);
            this.textBox1.TabIndex = 0;
            this.textBox1.Text = "Event revision";
            this.textBox1.TextChanged += new System.EventHandler(this.textBox1_TextChanged);
            //
            // S051EventRevisionForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(280, 140);
            this.Controls.Add(this.textBox1);
            this.Name = "S051EventRevisionForm";
            this.Text = "S051 event rewire";
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
