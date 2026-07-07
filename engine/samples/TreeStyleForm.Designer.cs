namespace SampleApp
{
    partial class TreeStyleForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.TreeView treeView1;

        private void InitializeComponent()
        {
            System.Windows.Forms.TreeNode treeNode1 = new System.Windows.Forms.TreeNode("Important");
            System.Windows.Forms.TreeNode treeNode2 = new System.Windows.Forms.TreeNode("Normal");
            this.treeView1 = new System.Windows.Forms.TreeView();
            this.SuspendLayout();
            //
            // treeView1
            //
            treeNode1.BackColor = System.Drawing.Color.FromArgb(255, 224, 192);
            treeNode1.ForeColor = System.Drawing.Color.Red;
            treeNode1.Name = "nodeImportant";
            treeNode1.NodeFont = new System.Drawing.Font("Microsoft Sans Serif", 9F, System.Drawing.FontStyle.Bold);
            treeNode2.ForeColor = System.Drawing.SystemColors.GrayText;
            treeNode2.Name = "nodeNormal";
            this.treeView1.Location = new System.Drawing.Point(12, 12);
            this.treeView1.Name = "treeView1";
            this.treeView1.Nodes.AddRange(new System.Windows.Forms.TreeNode[] {
            treeNode1,
            treeNode2});
            this.treeView1.Size = new System.Drawing.Size(200, 300);
            this.treeView1.TabIndex = 0;
            //
            // TreeStyleForm
            //
            this.ClientSize = new System.Drawing.Size(284, 361);
            this.Controls.Add(this.treeView1);
            this.Name = "TreeStyleForm";
            this.Text = "Tree Style Form";
            this.ResumeLayout(false);
        }
    }
}
