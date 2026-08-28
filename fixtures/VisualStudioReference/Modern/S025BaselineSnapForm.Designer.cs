namespace VisualStudioReference.Modern;

partial class S025BaselineSnapForm
{
    private System.Windows.Forms.Button snapButton = null!;
    private System.Windows.Forms.TextBox referenceTextBox = null!;

    private void InitializeComponent()
    {
        snapButton = new System.Windows.Forms.Button();
        referenceTextBox = new System.Windows.Forms.TextBox();
        SuspendLayout();
        //
        // snapButton
        //
        snapButton.Location = new System.Drawing.Point(32, 80);
        snapButton.Name = "snapButton";
        snapButton.Size = new System.Drawing.Size(100, 30);
        snapButton.TabIndex = 0;
        snapButton.Text = "Snap button";
        snapButton.UseVisualStyleBackColor = true;
        //
        // referenceTextBox
        //
        referenceTextBox.Location = new System.Drawing.Point(180, 40);
        referenceTextBox.Name = "referenceTextBox";
        referenceTextBox.Size = new System.Drawing.Size(120, 23);
        referenceTextBox.TabIndex = 1;
        referenceTextBox.Text = "Reference text";
        //
        // S025BaselineSnapForm
        //
        AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        ClientSize = new System.Drawing.Size(360, 180);
        Controls.Add(referenceTextBox);
        Controls.Add(snapButton);
        Name = "S025BaselineSnapForm";
        Text = "S025 baseline snap";
        ResumeLayout(false);
        PerformLayout();
    }
}
