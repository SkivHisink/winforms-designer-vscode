namespace SampleApp
{
    // Fixture for the ImageIndex/ImageKey dropdown: a Button whose ImageList is set → the property grid should offer a
    // DROPDOWN of the ImageList's keys/indices (ImageKeyConverter / ImageIndexConverter, given a describe-time context)
    // instead of a raw text/number field. Images are added PROGRAMMATICALLY (Images.Add) — VS normally serializes them
    // as a BinaryFormatter ImageStream in the .resx, which .NET 9 can't deserialize, so a keyed in-code ImageList keeps
    // the fixture renderable on net9 too (net48 renders the real compiled instance).
    partial class ImageListForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.ImageList imageList1;
        private System.Windows.Forms.Button button1;
        // A TreeView using the SAME ImageList: its ImageIndex uses the internal NoneExcludedImageIndexConverter, which has
        // NO "(none)"/-1 sentinel (it excludes "no image"). So its dropdown must show exactly the real indices [0, 1] — the
        // regression case the old "<2" gate wrongly suppressed for a 1-image list (codex review finding #2).
        private System.Windows.Forms.TreeView treeView1;

        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.imageList1 = new System.Windows.Forms.ImageList(this.components);
            this.button1 = new System.Windows.Forms.Button();
            this.treeView1 = new System.Windows.Forms.TreeView();
            this.SuspendLayout();
            //
            // imageList1
            //
            this.imageList1.ImageSize = new System.Drawing.Size(16, 16);
            this.imageList1.Images.Add("first", new System.Drawing.Bitmap(16, 16));
            this.imageList1.Images.Add("second", new System.Drawing.Bitmap(16, 16));
            //
            // button1
            //
            this.button1.ImageList = this.imageList1;
            this.button1.ImageKey = "first";
            this.button1.Location = new System.Drawing.Point(20, 20);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(100, 30);
            this.button1.TabIndex = 0;
            this.button1.Text = "Btn";
            //
            // treeView1
            //
            this.treeView1.ImageList = this.imageList1;
            this.treeView1.ImageIndex = 1;
            this.treeView1.Location = new System.Drawing.Point(20, 60);
            this.treeView1.Name = "treeView1";
            this.treeView1.Size = new System.Drawing.Size(150, 70);
            this.treeView1.TabIndex = 1;
            //
            // ImageListForm
            //
            this.ClientSize = new System.Drawing.Size(200, 150);
            this.Controls.Add(this.treeView1);
            this.Controls.Add(this.button1);
            this.Name = "ImageListForm";
            this.Text = "ImageListForm";
            this.ResumeLayout(false);
        }
    }
}
