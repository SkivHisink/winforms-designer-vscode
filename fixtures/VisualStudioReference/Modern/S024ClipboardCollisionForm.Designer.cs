namespace VisualStudioReference.Modern;

partial class S024ClipboardCollisionForm
{
    private System.Windows.Forms.Button submitButton = null!;

    private void InitializeComponent()
    {
        this.submitButton = new System.Windows.Forms.Button();
        this.SuspendLayout();
        //
        // submitButton
        //
        this.submitButton.Location = new System.Drawing.Point(40, 40);
        this.submitButton.Name = "submitButton";
        this.submitButton.Size = new System.Drawing.Size(124, 32);
        this.submitButton.TabIndex = 0;
        this.submitButton.Text = "Submit existing";
        this.submitButton.UseVisualStyleBackColor = true;
        //
        // S024ClipboardCollisionForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(320, 180);
        this.Controls.Add(this.submitButton);
        this.Name = "S024ClipboardCollisionForm";
        this.Text = "S024 clipboard name collision";
        this.ResumeLayout(false);
    }
}
