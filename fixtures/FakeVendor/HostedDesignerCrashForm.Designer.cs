namespace FakeVendor
{
    partial class HostedDesignerCrashForm
    {
        private System.ComponentModel.IContainer components = null;
        private CrashOnInitializeControl crashControl1;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null)) components.Dispose();
            base.Dispose(disposing);
        }

        private void InitializeComponent()
        {
            this.crashControl1 = new FakeVendor.CrashOnInitializeControl();
            this.SuspendLayout();
            //
            // crashControl1
            //
            this.crashControl1.Location = new System.Drawing.Point(24, 28);
            this.crashControl1.Name = "crashControl1";
            this.crashControl1.Size = new System.Drawing.Size(176, 32);
            this.crashControl1.TabIndex = 0;
            this.crashControl1.Text = "Generic control remains usable";
            this.crashControl1.UseVisualStyleBackColor = true;
            //
            // HostedDesignerCrashForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(360, 140);
            this.Controls.Add(this.crashControl1);
            this.Name = "HostedDesignerCrashForm";
            this.Text = "Hosted designer crash quarantine";
            this.ResumeLayout(false);
        }
    }
}
