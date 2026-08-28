namespace VisualStudioReference.Modern;

public partial class S009Outer
{
    public partial class InnerForm
    {
        private System.Windows.Forms.Button nestedButton = null!;

        private void InitializeComponent()
        {
            this.nestedButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // nestedButton
            //
            this.nestedButton.Location = new System.Drawing.Point(48, 44);
            this.nestedButton.Name = "nestedButton";
            this.nestedButton.Size = new System.Drawing.Size(164, 42);
            this.nestedButton.TabIndex = 0;
            this.nestedButton.Text = "Nested form";
            this.nestedButton.UseVisualStyleBackColor = true;
            //
            // InnerForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(320, 160);
            this.Controls.Add(this.nestedButton);
            this.Name = "InnerForm";
            this.Text = "S009 nested partial form";
            this.ResumeLayout(false);
        }
    }
}
