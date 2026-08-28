namespace VisualStudioReference.Net48
{
    partial class S014TextBoxForm
    {
        private System.Windows.Forms.TextBox referenceTextBox;

        private void InitializeComponent()
        {
            this.referenceTextBox = new System.Windows.Forms.TextBox();
            this.SuspendLayout();
            //
            // referenceTextBox
            //
            this.referenceTextBox.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
            this.referenceTextBox.Location = new System.Drawing.Point(34, 38);
            this.referenceTextBox.Multiline = true;
            this.referenceTextBox.Name = "referenceTextBox";
            this.referenceTextBox.ScrollBars = System.Windows.Forms.ScrollBars.Vertical;
            this.referenceTextBox.Size = new System.Drawing.Size(246, 92);
            this.referenceTextBox.TabIndex = 0;
            this.referenceTextBox.Text = "Line one\r\nLine two\r\nLine three\r\nLine four\r\nLine five";
            //
            // S014TextBoxForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(360, 180);
            this.Controls.Add(this.referenceTextBox);
            this.Name = "S014TextBoxForm";
            this.Text = "S014 TextBox reference";
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
