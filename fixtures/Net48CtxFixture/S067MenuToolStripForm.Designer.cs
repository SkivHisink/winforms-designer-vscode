namespace SampleApp
{
    partial class S067MenuToolStripForm
    {
        private System.Windows.Forms.MenuStrip menuStrip1;
        private System.Windows.Forms.ToolStripMenuItem fileMenu;
        private System.Windows.Forms.ToolStripMenuItem toolsMenu;
        private System.Windows.Forms.ToolStripMenuItem helpMenu;
        private System.Windows.Forms.ToolStrip toolStrip1;
        private System.Windows.Forms.ToolStripButton newButton;
        private System.Windows.Forms.ToolStripButton saveButton;
        private System.Windows.Forms.ToolStripButton openButton;

        private void InitializeComponent()
        {
            this.menuStrip1 = new System.Windows.Forms.MenuStrip();
            this.fileMenu = new System.Windows.Forms.ToolStripMenuItem();
            this.toolsMenu = new System.Windows.Forms.ToolStripMenuItem();
            this.helpMenu = new System.Windows.Forms.ToolStripMenuItem();
            this.toolStrip1 = new System.Windows.Forms.ToolStrip();
            this.newButton = new System.Windows.Forms.ToolStripButton();
            this.saveButton = new System.Windows.Forms.ToolStripButton();
            this.openButton = new System.Windows.Forms.ToolStripButton();
            this.menuStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {
                this.fileMenu,
                this.toolsMenu,
                this.helpMenu});
            this.toolStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {
                this.newButton,
                this.saveButton,
                this.openButton});
            this.fileMenu.Name = "fileMenu";
            this.fileMenu.Text = "File";
            this.toolsMenu.Name = "toolsMenu";
            this.toolsMenu.Text = "Tools";
            this.helpMenu.Name = "helpMenu";
            this.helpMenu.Text = "Help";
            this.newButton.Name = "newButton";
            this.newButton.Text = "New";
            this.saveButton.Name = "saveButton";
            this.saveButton.Text = "Save";
            this.openButton.Name = "openButton";
            this.openButton.Text = "Open";
            this.menuStrip1.Name = "menuStrip1";
            this.toolStrip1.Location = new System.Drawing.Point(0, 24);
            this.toolStrip1.Name = "toolStrip1";
            this.Controls.Add(this.toolStrip1);
            this.Controls.Add(this.menuStrip1);
            this.MainMenuStrip = this.menuStrip1;
            this.ClientSize = new System.Drawing.Size(420, 220);
            this.Name = "S067MenuToolStripForm";
        }
    }
}
