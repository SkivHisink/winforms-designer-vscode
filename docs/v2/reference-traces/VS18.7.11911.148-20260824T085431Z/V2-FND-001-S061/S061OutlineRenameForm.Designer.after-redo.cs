namespace VisualStudioReference.Modern;

partial class S061OutlineRenameForm
{
    private System.Windows.Forms.Button submitButton = null!;
    private System.Windows.Forms.TextBox textBox1 = null!;

    private void InitializeComponent()
    {
        submitButton = new System.Windows.Forms.Button();
        textBox1 = new System.Windows.Forms.TextBox();
        SuspendLayout();
        // 
        // submitButton
        // 
        submitButton.Location = new System.Drawing.Point(20, 20);
        submitButton.Name = "submitButton";
        submitButton.Size = new System.Drawing.Size(110, 30);
        submitButton.TabIndex = 0;
        submitButton.Text = "button1";
        submitButton.UseVisualStyleBackColor = true;
        // 
        // textBox1
        // 
        textBox1.Location = new System.Drawing.Point(20, 70);
        textBox1.Name = "textBox1";
        textBox1.Size = new System.Drawing.Size(160, 23);
        textBox1.TabIndex = 1;
        // 
        // S061OutlineRenameForm
        // 
        AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        ClientSize = new System.Drawing.Size(320, 150);
        Controls.Add(textBox1);
        Controls.Add(submitButton);
        Name = "S061OutlineRenameForm";
        Text = "S061 outline rename";
        ResumeLayout(false);
        PerformLayout();
    }
}
