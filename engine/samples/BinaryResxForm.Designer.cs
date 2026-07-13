namespace SampleApp
{
    // 0.10.0 S3 fixture: a form whose sibling .resx carries a BinaryFormatter-serialized ImageStream
    // (imageList1.ImageStream). net9 CANNOT materialize it (BinaryFormatter is refused before deserializing),
    // so the ImageList renders empty and UnrenderableResxCount >= 1 → honest banner. The GetObject reference is
    // interpreted; the resource is refused (returns null) so the form still renders. net48 renders it for real.
    partial class BinaryResxForm
    {
        private System.ComponentModel.IContainer components;
        private System.Windows.Forms.ImageList imageList1;
        private System.Windows.Forms.Button okButton;

        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(BinaryResxForm));
            this.imageList1 = new System.Windows.Forms.ImageList(this.components);
            this.okButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // imageList1
            //
            this.imageList1.ImageStream = ((System.Windows.Forms.ImageListStreamer)(resources.GetObject("imageList1.ImageStream")));
            this.imageList1.TransparentColor = System.Drawing.Color.Transparent;
            //
            // okButton
            //
            this.okButton.Location = new System.Drawing.Point(24, 24);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(120, 30);
            this.okButton.Text = "OK";
            //
            // BinaryResxForm
            //
            this.ClientSize = new System.Drawing.Size(320, 160);
            this.Controls.Add(this.okButton);
            this.Name = "BinaryResxForm";
            this.Text = "Binary Resx Form";
            this.ResumeLayout(false);
        }
    }
}
