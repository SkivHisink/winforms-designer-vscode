namespace VisualStudioReference.Net48
{
    partial class S079RtlLayoutForm
    {
        private System.Windows.Forms.Button primaryButton;
        private System.Windows.Forms.Label statusLabel;

        private void InitializeComponent()
        {
            this.primaryButton = new System.Windows.Forms.Button();
            this.statusLabel = new System.Windows.Forms.Label();
            this.SuspendLayout();
            //
            // primaryButton
            //
            this.primaryButton.Location = new System.Drawing.Point(20, 30);
            this.primaryButton.Name = "primaryButton";
            this.primaryButton.Size = new System.Drawing.Size(90, 28);
            this.primaryButton.TabIndex = 0;
            this.primaryButton.Text = "RTL primary";
            this.primaryButton.UseVisualStyleBackColor = true;
            //
            // statusLabel
            //
            this.statusLabel.Location = new System.Drawing.Point(50, 82);
            this.statusLabel.Name = "statusLabel";
            this.statusLabel.Size = new System.Drawing.Size(80, 20);
            this.statusLabel.TabIndex = 1;
            this.statusLabel.Text = "RTL status";
            //
            // S079RtlLayoutForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(320, 160);
            this.Controls.Add(this.statusLabel);
            this.Controls.Add(this.primaryButton);
            this.Name = "S079RtlLayoutForm";
            this.RightToLeft = System.Windows.Forms.RightToLeft.Yes;
            this.RightToLeftLayout = true;
            this.Text = "S079 RTL layout";
            this.ResumeLayout(false);
        }
    }
}
