namespace DemoApp
{
    partial class S045ColorEditorForm
    {
        private System.Windows.Forms.Button colorButton;

        private void InitializeComponent()
        {
            this.colorButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // colorButton
            //
            this.colorButton.BackColor = System.Drawing.Color.Red;
            this.colorButton.Location = new System.Drawing.Point(24, 24);
            this.colorButton.Name = "colorButton";
            this.colorButton.Size = new System.Drawing.Size(176, 36);
            this.colorButton.Text = "Color editor";
            this.colorButton.UseVisualStyleBackColor = false;
            //
            // S045ColorEditorForm
            //
            this.ClientSize = new System.Drawing.Size(360, 180);
            this.Controls.Add(this.colorButton);
            this.Name = "S045ColorEditorForm";
            this.Text = "UITypeEditor color";
            this.ResumeLayout(false);
        }
    }
}
