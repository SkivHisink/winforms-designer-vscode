namespace VisualStudioReference.Modern;

partial class S042PaddingForm
{
    private System.Windows.Forms.Button button1 = null!;

    private void InitializeComponent()
    {
        this.button1 = new System.Windows.Forms.Button();
        this.SuspendLayout();
        //
        // button1
        //
        this.button1.Location = new System.Drawing.Point(36, 42);
        this.button1.Name = "button1";
        this.button1.Padding = new System.Windows.Forms.Padding(3, 4, 5, 6);
        this.button1.Size = new System.Drawing.Size(160, 40);
        this.button1.TabIndex = 0;
        this.button1.Text = "Padding 3,4,5,6";
        this.button1.UseVisualStyleBackColor = true;
        //
        // S042PaddingForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(320, 160);
        this.Controls.Add(this.button1);
        this.Name = "S042PaddingForm";
        this.Text = "S042 Padding subproperty";
        this.ResumeLayout(false);
    }
}
