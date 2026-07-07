namespace SampleApp
{
    partial class LinesForm
    {
        private System.Windows.Forms.Label headerLabel;
        private System.Windows.Forms.TextBox notesBox;
        private System.Windows.Forms.Button okButton;

        private void InitializeComponent()
        {
            this.headerLabel = new System.Windows.Forms.Label();
            this.notesBox = new System.Windows.Forms.TextBox();
            this.okButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // headerLabel
            //
            this.headerLabel.Location = new System.Drawing.Point(16, 12);
            this.headerLabel.Name = "headerLabel";
            this.headerLabel.Size = new System.Drawing.Size(367, 20);
            this.headerLabel.Text = "Notes";
            //
            // notesBox
            //
            // Multi-line content is serialized as Text (Lines is DesignerSerializationVisibility.Hidden — VS never
            // emits `Lines =`), so the string[] "…" editor reads/writes the effective Text assignment.
            this.notesBox.Cursor = System.Windows.Forms.Cursors.Hand;
            this.notesBox.Location = new System.Drawing.Point(16, 40);
            this.notesBox.Multiline = true;
            this.notesBox.Name = "notesBox";
            this.notesBox.Size = new System.Drawing.Size(367, 160);
            this.notesBox.Text = "First line\r\nSecond line\r\nThird line";
            //
            // okButton
            //
            this.okButton.Location = new System.Drawing.Point(282, 212);
            this.okButton.Name = "okButton";
            this.okButton.Size = new System.Drawing.Size(101, 27);
            this.okButton.Text = "OK";
            //
            // LinesForm
            //
            this.ClientSize = new System.Drawing.Size(400, 255);
            this.Controls.Add(this.headerLabel);
            this.Controls.Add(this.notesBox);
            this.Controls.Add(this.okButton);
            this.Name = "LinesForm";
            this.Text = "Lines Form";
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
