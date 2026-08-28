namespace DemoApp
{
    partial class S118ImageListRollbackForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.ImageList imageList1;
        private System.Windows.Forms.Button button1;

        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.imageList1 = new System.Windows.Forms.ImageList(this.components);
            this.button1 = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // imageList1
            //
            this.imageList1.ColorDepth = System.Windows.Forms.ColorDepth.Depth32Bit;
            this.imageList1.ImageSize = new System.Drawing.Size(16, 16);
            this.imageList1.TransparentColor = System.Drawing.Color.Transparent;
            //
            // button1
            //
            this.button1.ImageList = this.imageList1;
            this.button1.Location = new System.Drawing.Point(24, 24);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(176, 36);
            this.button1.Text = "Rollback target";
            this.button1.UseVisualStyleBackColor = true;
            //
            // S118ImageListRollbackForm
            //
            this.ClientSize = new System.Drawing.Size(360, 180);
            this.Controls.Add(this.button1);
            this.Name = "S118ImageListRollbackForm";
            this.Text = "ImageList rollback";
            this.ResumeLayout(false);
        }
    }
}
