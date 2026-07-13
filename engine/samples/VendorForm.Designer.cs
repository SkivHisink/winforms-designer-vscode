namespace SampleApp
{
    partial class VendorForm
    {
        private System.Windows.Forms.Button vendorButton;

        private void InitializeComponent()
        {
            this.vendorButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // vendorButton
            //
            this.vendorButton.Location = new System.Drawing.Point(24, 24);
            this.vendorButton.Name = "vendorButton";
            this.vendorButton.Size = new System.Drawing.Size(140, 30);
            this.vendorButton.Text = "On a vendor form";
            //
            // VendorForm
            //
            this.ClientSize = new System.Drawing.Size(320, 160);
            this.Controls.Add(this.vendorButton);
            this.Name = "VendorForm";
            this.Text = "Vendor Form";
            this.ResumeLayout(false);
        }
    }
}
