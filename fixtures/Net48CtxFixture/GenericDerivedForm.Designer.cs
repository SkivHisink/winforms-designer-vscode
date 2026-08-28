namespace SampleApp
{
    partial class GenericDerivedForm
    {
        private System.Windows.Forms.Button derivedButton;

        private void InitializeComponent()
        {
            this.derivedButton = new System.Windows.Forms.Button();
            this.derivedButton.Location = new System.Drawing.Point(12, 48);
            this.derivedButton.Name = "derivedButton";
            this.derivedButton.Size = new System.Drawing.Size(100, 23);
            this.derivedButton.Text = "Derived";
            this.Controls.Add(this.derivedButton);
            this.ClientSize = new System.Drawing.Size(260, 130);
            this.Name = "GenericDerivedForm";
        }
    }
}
