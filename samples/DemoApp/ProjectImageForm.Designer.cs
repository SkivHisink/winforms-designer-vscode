namespace DemoApp
{
    partial class ProjectImageForm
    {
        private System.Windows.Forms.Button imageButton;

        private void InitializeComponent()
        {
            this.imageButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            this.imageButton.Location = new System.Drawing.Point(24, 24);
            this.imageButton.Name = "imageButton";
            this.imageButton.Size = new System.Drawing.Size(120, 40);
            this.imageButton.Text = "Logo";
            this.Controls.Add(this.imageButton);
            this.ClientSize = new System.Drawing.Size(280, 140);
            this.Name = "ProjectImageForm";
            this.Text = "Project image resource";
            this.ResumeLayout(false);
        }
    }
}
