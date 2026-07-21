namespace FakeVendor
{
    // A VS-style .Designer.cs using the FakeVendor controls — the interpreter's vendor-pattern corpus form. Exercises:
    // vendor control construction, a property CHAIN onto an Appearance sub-object, and a real ISupportInitialize
    // Begin/EndInit bracket around a vendor control. The differential comparator asserts the interpreted render
    // reproduces the compiled one.
    partial class FakeVendorForm
    {
        private FakeVendor.FancyButton fancyButton1;
        private FakeVendor.DataPanel dataPanel1;

        private void InitializeComponent()
        {
            this.fancyButton1 = new FakeVendor.FancyButton();
            this.dataPanel1 = new FakeVendor.DataPanel();
            ((System.ComponentModel.ISupportInitialize)(this.dataPanel1)).BeginInit();
            this.SuspendLayout();
            this.fancyButton1.Text = "Fancy";
            this.fancyButton1.Location = new System.Drawing.Point(12, 12);
            this.fancyButton1.Size = new System.Drawing.Size(120, 32);
            this.fancyButton1.Appearance.BorderColor = System.Drawing.Color.Red;
            this.fancyButton1.Appearance.BorderWidth = 3;
            this.dataPanel1.Location = new System.Drawing.Point(12, 60);
            this.dataPanel1.Size = new System.Drawing.Size(240, 120);
            this.Controls.Add(this.fancyButton1);
            this.Controls.Add(this.dataPanel1);
            ((System.ComponentModel.ISupportInitialize)(this.dataPanel1)).EndInit();
            this.ClientSize = new System.Drawing.Size(280, 200);
            this.ResumeLayout(false);
        }
    }
}
