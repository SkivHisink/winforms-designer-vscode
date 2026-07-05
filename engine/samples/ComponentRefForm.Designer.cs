namespace WinFormsDesigner.Samples
{
    // Fixture for component-reference property RHS (this.<prop> = this.<component>): the form's AcceptButton /
    // CancelButton point at Button components — the reference assignment VS emits for a dialog. These serialize
    // cleanly on .NET 9 (a plain component reference, no BinaryFormatter), so the form is round-trip safe.
    partial class ComponentRefForm
    {
        private void InitializeComponent()
        {
            this.okButton = new System.Windows.Forms.Button();
            this.cancelButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            this.okButton.Location = new System.Drawing.Point(40, 40);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(100, 30);
            this.okButton.Text = "OK";
            this.cancelButton.Location = new System.Drawing.Point(160, 40);
            this.cancelButton.Name = "cancelButton";
            this.cancelButton.Size = new System.Drawing.Size(100, 30);
            this.cancelButton.Text = "Cancel";
            this.AcceptButton = this.okButton;
            this.CancelButton = this.cancelButton;
            this.ClientSize = new System.Drawing.Size(300, 150);
            this.Controls.Add(this.okButton);
            this.Controls.Add(this.cancelButton);
            this.Name = "ComponentRefForm";
            this.Text = "ComponentRefForm";
            this.ResumeLayout(false);
        }

        private System.Windows.Forms.Button okButton;
        private System.Windows.Forms.Button cancelButton;
    }
}
