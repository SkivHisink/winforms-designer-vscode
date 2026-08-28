namespace VisualStudioReference.Modern;

partial class S038MultiPropertyForm
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
        this.button1.Location = new System.Drawing.Point(28, 32);
        this.button1.Name = "button1";
        this.button1.Size = new System.Drawing.Size(120, 32);
        this.button1.TabIndex = 0;
        this.button1.Text = "Button text";
        this.button1.UseVisualStyleBackColor = true;
        //
        // textBox1
        //
        this.textBox1.Location = new System.Drawing.Point(28, 86);
        this.textBox1.Name = "textBox1";
        this.textBox1.Size = new System.Drawing.Size(180, 23);
        this.textBox1.TabIndex = 1;
        this.textBox1.Text = "TextBox text";
        //
        // S038MultiPropertyForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(320, 160);
        this.Controls.Add(this.textBox1);
        this.Controls.Add(this.button1);
        this.Name = "S038MultiPropertyForm";
        this.Text = "S038 multi-object Properties";
        this.ResumeLayout(false);
        this.PerformLayout();
    }
}
