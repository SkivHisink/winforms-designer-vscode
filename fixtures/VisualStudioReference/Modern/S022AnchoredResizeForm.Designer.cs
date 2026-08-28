namespace VisualStudioReference.Modern;

partial class S022AnchoredResizeForm
{
    private System.Windows.Forms.Button anchoredButton = null!;

    private void InitializeComponent()
    {
        anchoredButton = new System.Windows.Forms.Button();
        SuspendLayout();
        //
        // anchoredButton
        //
        anchoredButton.Anchor = System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left | System.Windows.Forms.AnchorStyles.Right;
        anchoredButton.Location = new System.Drawing.Point(24, 48);
        anchoredButton.Name = "anchoredButton";
        anchoredButton.Size = new System.Drawing.Size(120, 30);
        anchoredButton.TabIndex = 0;
        anchoredButton.Text = "Anchored button";
        anchoredButton.UseVisualStyleBackColor = true;
        //
        // S022AnchoredResizeForm
        //
        AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        ClientSize = new System.Drawing.Size(360, 180);
        Controls.Add(anchoredButton);
        Name = "S022AnchoredResizeForm";
        Text = "S022 anchored resize";
        ResumeLayout(false);
    }
}
