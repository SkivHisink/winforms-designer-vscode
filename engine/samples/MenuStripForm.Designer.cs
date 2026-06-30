namespace WinFormsDesigner.Samples
{
    // Fixture for the .NET-9 ToolStrip serialize limit: MenuStrip/ToolStrip LOAD and RENDER fine, but the
    // CodeDom host serializer pulls BinaryFormatter-backed resources (removed in .NET 9), so the full
    // normalize-save path must DEGRADE to read-only (safe=false) rather than throw out of the RPC.
    partial class MenuStripForm
    {
        private void InitializeComponent()
        {
            this.menuStrip1 = new System.Windows.Forms.MenuStrip();
            this.fileToolStripMenuItem = new System.Windows.Forms.ToolStripMenuItem();
            this.menuStrip1.SuspendLayout();
            this.SuspendLayout();
            this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {
            this.fileToolStripMenuItem});
            this.menuStrip1.Location = new System.Drawing.Point(0, 0);
            this.menuStrip1.Name = "menuStrip1";
            this.menuStrip1.Size = new System.Drawing.Size(320, 24);
            this.fileToolStripMenuItem.Name = "fileToolStripMenuItem";
            this.fileToolStripMenuItem.Size = new System.Drawing.Size(37, 20);
            this.fileToolStripMenuItem.Text = "File";
            this.Controls.Add(this.menuStrip1);
            this.ClientSize = new System.Drawing.Size(320, 180);
            this.MainMenuStrip = this.menuStrip1;
            this.Name = "MenuStripForm";
            this.Text = "MenuStripForm";
            this.menuStrip1.ResumeLayout(false);
            this.menuStrip1.PerformLayout();
            this.ResumeLayout(false);
            this.PerformLayout();
        }

        private System.Windows.Forms.MenuStrip menuStrip1;
        private System.Windows.Forms.ToolStripMenuItem fileToolStripMenuItem;
    }
}
