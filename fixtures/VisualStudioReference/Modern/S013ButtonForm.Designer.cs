namespace VisualStudioReference.Modern;

partial class S013ButtonForm
{
    private System.Windows.Forms.Button referenceButton = null!;

    private void InitializeComponent()
    {
        this.referenceButton = new System.Windows.Forms.Button();
        this.SuspendLayout();
        //
        // referenceButton
        //
        this.referenceButton.FlatStyle = System.Windows.Forms.FlatStyle.Popup;
        this.referenceButton.Image = System.Drawing.SystemIcons.Information.ToBitmap();
        this.referenceButton.ImageAlign = System.Drawing.ContentAlignment.MiddleLeft;
        this.referenceButton.Location = new System.Drawing.Point(36, 42);
        this.referenceButton.Name = "referenceButton";
        this.referenceButton.Size = new System.Drawing.Size(208, 54);
        this.referenceButton.TabIndex = 0;
        this.referenceButton.Text = "Button reference";
        this.referenceButton.TextImageRelation = System.Windows.Forms.TextImageRelation.ImageBeforeText;
        this.referenceButton.UseVisualStyleBackColor = true;
        //
        // S013ButtonForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(360, 180);
        this.Controls.Add(this.referenceButton);
        this.Name = "S013ButtonForm";
        this.Text = "S013 Button reference";
        this.ResumeLayout(false);
    }
}
