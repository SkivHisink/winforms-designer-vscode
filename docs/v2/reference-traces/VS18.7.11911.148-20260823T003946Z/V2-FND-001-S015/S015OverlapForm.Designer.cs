namespace VisualStudioReference.Modern;

partial class S015OverlapForm
{
    private System.Windows.Forms.Label bottomLabel = null!;
    private System.Windows.Forms.Label topLabel = null!;

    private void InitializeComponent()
    {
        this.bottomLabel = new System.Windows.Forms.Label();
        this.topLabel = new System.Windows.Forms.Label();
        this.SuspendLayout();
        //
        // bottomLabel
        //
        this.bottomLabel.BackColor = System.Drawing.Color.MistyRose;
        this.bottomLabel.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
        this.bottomLabel.Location = new System.Drawing.Point(52, 48);
        this.bottomLabel.Name = "bottomLabel";
        this.bottomLabel.Size = new System.Drawing.Size(160, 48);
        this.bottomLabel.TabIndex = 1;
        this.bottomLabel.Text = "Bottom z-order";
        this.bottomLabel.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
        //
        // topLabel
        //
        this.topLabel.BackColor = System.Drawing.Color.LightSkyBlue;
        this.topLabel.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
        this.topLabel.Location = new System.Drawing.Point(52, 48);
        this.topLabel.Name = "topLabel";
        this.topLabel.Size = new System.Drawing.Size(160, 48);
        this.topLabel.TabIndex = 0;
        this.topLabel.Text = "Top z-order";
        this.topLabel.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
        //
        // S015OverlapForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(320, 180);
        this.Controls.Add(this.topLabel);
        this.Controls.Add(this.bottomLabel);
        this.Name = "S015OverlapForm";
        this.Text = "S015 overlapping z-order";
        this.ResumeLayout(false);
    }
}
