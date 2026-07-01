namespace SampleApp
{
    // Fixture for resx-backed image properties (BackgroundImage / PictureBox.Image): VS stores these as
    // resources.GetObject("...") against the sibling ImageForm.resx, NOT as inline literals. The interpreter
    // resolves them through the safe ResxResolver. Excluded from compilation (samples/**).
    partial class ImageForm
    {
        private System.ComponentModel.IContainer components = null;

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
            System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(ImageForm));
            this.pictureBox1 = new System.Windows.Forms.PictureBox();
            this.SuspendLayout();
            //
            // pictureBox1
            //
            this.pictureBox1.Image = ((System.Drawing.Image)(resources.GetObject("pictureBox1.Image")));
            this.pictureBox1.Location = new System.Drawing.Point(40, 40);
            this.pictureBox1.Name = "pictureBox1";
            this.pictureBox1.Size = new System.Drawing.Size(64, 64);
            this.pictureBox1.TabIndex = 0;
            //
            // ImageForm
            //
            this.BackgroundImage = ((System.Drawing.Image)(resources.GetObject("$this.BackgroundImage")));
            this.ClientSize = new System.Drawing.Size(300, 200);
            this.Controls.Add(this.pictureBox1);
            this.Name = "ImageForm";
            this.Text = "ImageForm";
            this.ResumeLayout(false);
        }

        private System.Windows.Forms.PictureBox pictureBox1;
    }
}
