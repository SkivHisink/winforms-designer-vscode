namespace VisualStudioReference.Modern;

partial class S030SameWidthForm
{
    private System.Windows.Forms.Button button1 = null!;
    private System.Windows.Forms.Button button2 = null!;
    private System.Windows.Forms.Button button3 = null!;

    private void InitializeComponent()
    {
        button1 = new System.Windows.Forms.Button();
        button2 = new System.Windows.Forms.Button();
        button3 = new System.Windows.Forms.Button();
        SuspendLayout();
        //
        // button1
        //
        button1.Location = new System.Drawing.Point(12, 10);
        button1.Name = "button1";
        button1.Size = new System.Drawing.Size(120, 30);
        button1.TabIndex = 0;
        button1.Text = "Primary width";
        button1.UseVisualStyleBackColor = true;
        //
        // button2
        //
        button2.Location = new System.Drawing.Point(42, 55);
        button2.Name = "button2";
        button2.Size = new System.Drawing.Size(60, 24);
        button2.TabIndex = 1;
        button2.Text = "Second";
        button2.UseVisualStyleBackColor = true;
        //
        // button3
        //
        button3.Location = new System.Drawing.Point(77, 100);
        button3.Name = "button3";
        button3.Size = new System.Drawing.Size(90, 36);
        button3.TabIndex = 2;
        button3.Text = "Third";
        button3.UseVisualStyleBackColor = true;
        //
        // S030SameWidthForm
        //
        AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        ClientSize = new System.Drawing.Size(320, 180);
        Controls.Add(button3);
        Controls.Add(button2);
        Controls.Add(button1);
        Name = "S030SameWidthForm";
        Text = "S030 make same width";
        ResumeLayout(false);
    }
}
