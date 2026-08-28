namespace VisualStudioReference.Modern;

partial class S050ExistingEventForm
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
        this.button1.Size = new System.Drawing.Size(168, 38);
        this.button1.TabIndex = 0;
        this.button1.Text = "Existing Click handler";
        this.button1.UseVisualStyleBackColor = true;
        this.button1.Click += this.button1_Click;
        //
        // S050ExistingEventForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(320, 150);
        this.Controls.Add(this.button1);
        this.Name = "S050ExistingEventForm";
        this.Text = "S050 existing event handler";
        this.ResumeLayout(false);
    }
}
