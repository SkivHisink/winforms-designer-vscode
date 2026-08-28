namespace VisualStudioReference.Modern;

partial class S061OutlineRenameForm
{
    private System.Windows.Forms.Button button1 = null!;
    private System.Windows.Forms.TextBox textBox1 = null!;

    private void InitializeComponent()
    {
        this.button1 = new System.Windows.Forms.Button();
        this.textBox1 = new System.Windows.Forms.TextBox();
        this.SuspendLayout();
        //
        // button1
        //
        this.button1.Location = new System.Drawing.Point(20, 20);
        this.button1.Name = "button1";
        this.button1.Size = new System.Drawing.Size(110, 30);
        this.button1.TabIndex = 0;
        this.button1.Text = "button1";
        this.button1.UseVisualStyleBackColor = true;
        //
        // textBox1
        //
        this.textBox1.Location = new System.Drawing.Point(20, 70);
        this.textBox1.Name = "textBox1";
        this.textBox1.Size = new System.Drawing.Size(160, 23);
        this.textBox1.TabIndex = 1;
        //
        // S061OutlineRenameForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(320, 150);
        this.Controls.Add(this.textBox1);
        this.Controls.Add(this.button1);
        this.Name = "S061OutlineRenameForm";
        this.Text = "S061 outline rename";
        this.ResumeLayout(false);
        this.PerformLayout();
    }
}
