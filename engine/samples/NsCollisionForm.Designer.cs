namespace SampleApp
{
    partial class NsCollisionForm
    {
        private System.Windows.Forms.Button ownButton;

        private void InitializeComponent()
        {
            this.ownButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // ownButton
            //
            this.ownButton.Location = new System.Drawing.Point(24, 96);
            this.ownButton.Name = "ownButton";
            this.ownButton.Size = new System.Drawing.Size(140, 30);
            this.ownButton.Text = "Own control";
            //
            // NsCollisionForm
            //
            this.ClientSize = new System.Drawing.Size(320, 200);
            this.Controls.Add(this.ownButton);
            this.Name = "NsCollisionForm";
            this.Text = "Namespace Collision Form";
            this.ResumeLayout(false);
        }
    }
}
