namespace VisualStudioReference.Modern;

partial class S046ColorEditorForm
{
    private System.Windows.Forms.Button button1 = null!;

    private void InitializeComponent()
    {
        this.button1 = new System.Windows.Forms.Button();
        this.SuspendLayout();
        //
        // button1
        //
        this.button1.BackColor = System.Drawing.Color.Red;
        this.button1.Location = new System.Drawing.Point(48, 54);
        this.button1.Name = "button1";
        this.button1.Size = new System.Drawing.Size(160, 42);
        this.button1.TabIndex = 0;
        this.button1.Text = "Red button";
        this.button1.UseVisualStyleBackColor = false;
        //
        // S046ColorEditorForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(360, 180);
        this.Controls.Add(this.button1);
        this.Name = "S046ColorEditorForm";
        this.Text = "S046 Color editor cancel";
        this.ResumeLayout(false);
    }
}
