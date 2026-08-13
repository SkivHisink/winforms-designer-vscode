namespace SampleApp
{
    using SampleApp.VendorLike;

    /// <summary>
    /// A designer file written the way real projects write them, not the way Visual Studio's generator does:
    /// the `using` sits INSIDE the namespace and the control is constructed by its UNQUALIFIED name. Together with
    /// VendorWidget's internal constructor and its non-IList Columns collection, this is the exact combination that
    /// made a real DevExpress form fall back to constructing the user's own compiled class — the one path that runs
    /// their constructor, field initializers and Load. It must interpret.
    /// </summary>
    partial class VendorShapedForm
    {
        private System.ComponentModel.IContainer components = null;
        private VendorWidget vendorWidget;
        private VendorColumn vendorColumn1;
        private System.Windows.Forms.Button okButton;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        private void InitializeComponent()
        {
            this.vendorColumn1 = new VendorColumn();
            this.vendorWidget = new VendorWidget();
            this.okButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // vendorColumn1
            //
            this.vendorColumn1.Caption = "declared-in-source";
            //
            // vendorWidget
            //
            this.vendorWidget.Columns.AddRange(new VendorColumn[] {
            this.vendorColumn1});
            this.vendorWidget.Location = new System.Drawing.Point(12, 12);
            this.vendorWidget.Name = "vendorWidget";
            this.vendorWidget.Size = new System.Drawing.Size(360, 180);
            this.vendorWidget.TabIndex = 0;
            //
            // okButton
            //
            this.okButton.Location = new System.Drawing.Point(297, 210);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(75, 26);
            this.okButton.TabIndex = 1;
            this.okButton.Text = "OK";
            //
            // VendorShapedForm
            //
            this.ClientSize = new System.Drawing.Size(384, 250);
            this.Controls.Add(this.vendorWidget);
            this.Controls.Add(this.okButton);
            this.Name = "VendorShapedForm";
            this.Text = "VendorShapedForm";
            this.ResumeLayout(false);
        }
    }
}
