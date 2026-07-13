namespace SampleApp
{
    partial class DerivedForm
    {
        private System.Windows.Forms.Button derivedButton;

        private void InitializeComponent()
        {
            this.derivedButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // derivedButton
            //
            this.derivedButton.Location = new System.Drawing.Point(24, 96);
            this.derivedButton.Name = "derivedButton";
            this.derivedButton.Size = new System.Drawing.Size(140, 30);
            this.derivedButton.Text = "From derived form";
            //
            // DerivedForm
            //
            this.ClientSize = new System.Drawing.Size(320, 200);
            this.Controls.Add(this.derivedButton);
            this.Name = "DerivedForm";
            this.Text = "Derived Form";
            this.ResumeLayout(false);
        }
    }
}
