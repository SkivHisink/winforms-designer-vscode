namespace VisualStudioReference.Modern;

partial class S086InheritedLockedBaseForm
{
    private System.Windows.Forms.Label privateInheritedLabel = null!;

    private void InitializeComponent()
    {
        this.privateInheritedLabel = new System.Windows.Forms.Label();
        this.SuspendLayout();
        //
        // privateInheritedLabel
        //
        this.privateInheritedLabel.AutoSize = false;
        this.privateInheritedLabel.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
        this.privateInheritedLabel.Location = new System.Drawing.Point(38, 44);
        this.privateInheritedLabel.Name = "privateInheritedLabel";
        this.privateInheritedLabel.Size = new System.Drawing.Size(180, 30);
        this.privateInheritedLabel.TabIndex = 0;
        this.privateInheritedLabel.Text = "Private inherited label";
        this.privateInheritedLabel.TextAlign = System.Drawing.ContentAlignment.MiddleCenter;
        //
        // S086InheritedLockedBaseForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(340, 180);
        this.Controls.Add(this.privateInheritedLabel);
        this.Name = "S086InheritedLockedBaseForm";
        this.Text = "S086 inherited locked base";
        this.ResumeLayout(false);
    }
}
