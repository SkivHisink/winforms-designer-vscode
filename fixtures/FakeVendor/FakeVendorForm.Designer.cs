namespace FakeVendor
{
    // A VS-style .Designer.cs using the FakeVendor controls — the interpreter's vendor-pattern corpus form. Exercises:
    // vendor control construction, a property CHAIN onto an Appearance sub-object, a real ISupportInitialize
    // Begin/EndInit bracket around a vendor control, the same bracket around an editor's SUB-OBJECT (the DevExpress
    // XtraEditors `.Properties` shape), and the left-nested parenthesized 4-flag Anchor VS emits for a control
    // anchored on every side. The differential comparator asserts the interpreted render reproduces the compiled one.
    partial class FakeVendorForm
    {
        private FakeVendor.FancyButton fancyButton1;
        private FakeVendor.DataPanel dataPanel1;
        private FakeVendor.VendorEdit vendorEdit1;
        private FakeVendor.VendorPanel vendorPanel1;

        private void InitializeComponent()
        {
            this.fancyButton1 = new FakeVendor.FancyButton();
            this.dataPanel1 = new FakeVendor.DataPanel();
            this.vendorEdit1 = new FakeVendor.VendorEdit();
            this.vendorPanel1 = new FakeVendor.VendorPanel();
            ((System.ComponentModel.ISupportInitialize)(this.dataPanel1)).BeginInit();
            ((System.ComponentModel.ISupportInitialize)(this.vendorEdit1.Properties)).BeginInit();
            this.SuspendLayout();
            this.fancyButton1.Text = "Fancy";
            this.fancyButton1.Location = new System.Drawing.Point(12, 12);
            this.fancyButton1.Size = new System.Drawing.Size(120, 32);
            this.fancyButton1.Appearance.BorderColor = System.Drawing.Color.Red;
            this.fancyButton1.Appearance.BorderWidth = 3;
            this.dataPanel1.Location = new System.Drawing.Point(12, 60);
            this.dataPanel1.Size = new System.Drawing.Size(240, 120);
            this.vendorEdit1.Anchor = ((System.Windows.Forms.AnchorStyles)((((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Bottom)
            | System.Windows.Forms.AnchorStyles.Left)
            | System.Windows.Forms.AnchorStyles.Right)));
            this.vendorEdit1.Location = new System.Drawing.Point(140, 12);
            this.vendorEdit1.Name = "vendorEdit1";
            this.vendorEdit1.Properties.Caption = "Vendor edit";
            this.vendorEdit1.Size = new System.Drawing.Size(120, 32);
            this.vendorPanel1.Location = new System.Drawing.Point(12, 200);
            this.vendorPanel1.Name = "vendorPanel1";
            this.vendorPanel1.Size = new System.Drawing.Size(120, 40);
            // Called AFTER Location so the hider's own offset survives into the rendered geometry: the compiled form
            // ends at x=17, and an interpreted replay that called Control.SuspendLayout would sit at x=12.
            this.vendorPanel1.SuspendLayout();
            this.vendorPanel1.ResumeLayout(false);
            this.Controls.Add(this.fancyButton1);
            this.Controls.Add(this.dataPanel1);
            this.Controls.Add(this.vendorEdit1);
            this.Controls.Add(this.vendorPanel1);
            ((System.ComponentModel.ISupportInitialize)(this.dataPanel1)).EndInit();
            ((System.ComponentModel.ISupportInitialize)(this.vendorEdit1.Properties)).EndInit();
            this.ClientSize = new System.Drawing.Size(280, 200);
            this.ResumeLayout(false);
        }
    }
}
