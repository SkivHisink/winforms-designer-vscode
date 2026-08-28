namespace VisualStudioReference.Net48
{
    partial class S011ConcreteCustomerForm
    {
        private System.Windows.Forms.Button derivedButton;

        private void InitializeComponent()
        {
            this.derivedButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // derivedButton
            //
            this.derivedButton.Location = new System.Drawing.Point(34, 78);
            this.derivedButton.Name = "derivedButton";
            this.derivedButton.Size = new System.Drawing.Size(196, 42);
            this.derivedButton.TabIndex = 0;
            this.derivedButton.Text = "Derived concrete form";
            this.derivedButton.UseVisualStyleBackColor = true;
            //
            // S011ConcreteCustomerForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(360, 180);
            this.Controls.Add(this.derivedButton);
            this.Name = "S011ConcreteCustomerForm";
            this.Text = "S011 generic base reference";
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
