namespace FakeVendor
{
    partial class HostedServiceKernelForm
    {
        private FakeVendor.HostedServiceControl hostedServiceControl1;

        private void InitializeComponent()
        {
            this.hostedServiceControl1 = new FakeVendor.HostedServiceControl();
            this.SuspendLayout();
            //
            // hostedServiceControl1
            //
            this.hostedServiceControl1.Location = new System.Drawing.Point(24, 24);
            this.hostedServiceControl1.Name = "hostedServiceControl1";
            this.hostedServiceControl1.Size = new System.Drawing.Size(120, 32);
            this.hostedServiceControl1.TabIndex = 0;
            this.hostedServiceControl1.Text = "Before service action";
            //
            // HostedServiceKernelForm
            //
            this.ClientSize = new System.Drawing.Size(360, 180);
            this.Controls.Add(this.hostedServiceControl1);
            this.Name = "HostedServiceKernelForm";
            this.Text = "Hosted Service Kernel";
            this.ResumeLayout(false);
        }
    }
}
