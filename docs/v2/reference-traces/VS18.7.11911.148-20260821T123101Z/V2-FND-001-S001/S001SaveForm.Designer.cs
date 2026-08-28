namespace VisualStudioReference.Modern
{
    partial class S001SaveForm
    {
        private System.ComponentModel.IContainer components = null!;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        #region Windows Form Designer generated code

        private void InitializeComponent()
        {
            this.saveButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // saveButton
            //
            this.saveButton.Location = new System.Drawing.Point(40, 52);
            this.saveButton.Name = "saveButton";
            this.saveButton.Size = new System.Drawing.Size(144, 42);
            this.saveButton.TabIndex = 0;
            this.saveButton.Text = "Save unchanged";
            this.saveButton.UseVisualStyleBackColor = true;
            //
            // S001SaveForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(320, 160);
            this.Controls.Add(this.saveButton);
            this.Name = "S001SaveForm";
            this.Text = "S001 save without edit";
            this.ResumeLayout(false);
        }

        #endregion

        private System.Windows.Forms.Button saveButton;
    }
}
