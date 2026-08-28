namespace VisualStudioReference.Modern;

partial class S026GridSnapForm
{
    private System.Windows.Forms.Label gridLabel = null!;
    private System.Windows.Forms.Button referenceButton = null!;

    private void InitializeComponent()
    {
        gridLabel = new System.Windows.Forms.Label();
        referenceButton = new System.Windows.Forms.Button();
        SuspendLayout();
        //
        // gridLabel
        //
        gridLabel.AutoSize = true;
        gridLabel.Location = new System.Drawing.Point(13, 25);
        gridLabel.Name = "gridLabel";
        gridLabel.Size = new System.Drawing.Size(57, 15);
        gridLabel.TabIndex = 0;
        gridLabel.Text = "Grid label";
        //
        // referenceButton
        //
        referenceButton.Location = new System.Drawing.Point(190, 96);
        referenceButton.Name = "referenceButton";
        referenceButton.Size = new System.Drawing.Size(110, 30);
        referenceButton.TabIndex = 1;
        referenceButton.Text = "Reference";
        referenceButton.UseVisualStyleBackColor = true;
        //
        // S026GridSnapForm
        //
        AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        ClientSize = new System.Drawing.Size(360, 180);
        Controls.Add(referenceButton);
        Controls.Add(gridLabel);
        Name = "S026GridSnapForm";
        Text = "S026 grid snap";
        ResumeLayout(false);
        PerformLayout();
    }
}
