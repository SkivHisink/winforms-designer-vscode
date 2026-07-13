namespace SampleApp
{
    partial class AliasedUcForm
    {
        private System.Windows.Forms.Button ucButton;

        private void InitializeComponent()
        {
            this.ucButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // ucButton
            //
            this.ucButton.Location = new System.Drawing.Point(12, 12);
            this.ucButton.Name = "ucButton";
            this.ucButton.Size = new System.Drawing.Size(140, 28);
            this.ucButton.Text = "On a user control";
            //
            // AliasedUcForm
            //
            this.Controls.Add(this.ucButton);
            this.Name = "AliasedUcForm";
            this.Size = new System.Drawing.Size(300, 120);
            this.ResumeLayout(false);
        }
    }
}
