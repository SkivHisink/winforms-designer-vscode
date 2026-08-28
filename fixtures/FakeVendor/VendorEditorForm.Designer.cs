namespace FakeVendor
{
    partial class VendorEditorForm
    {
        private FakeVendor.VendorEdit vendorEdit1;

        private void InitializeComponent()
        {
            this.vendorEdit1 = new FakeVendor.VendorEdit();
            this.SuspendLayout();
            this.vendorEdit1.Location = new System.Drawing.Point(12, 12);
            this.vendorEdit1.Name = "vendorEdit1";
            this.vendorEdit1.Size = new System.Drawing.Size(180, 32);
            this.vendorEdit1.Thresholds.Add(1);
            this.vendorEdit1.Thresholds.Add(2);
            this.Controls.Add(this.vendorEdit1);
            this.ClientSize = new System.Drawing.Size(240, 80);
            this.Name = "VendorEditorForm";
            this.Text = "Vendor collection";
            this.ResumeLayout(false);
        }
    }
}
