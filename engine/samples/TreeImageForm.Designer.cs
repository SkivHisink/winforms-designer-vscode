namespace SampleApp
{
    partial class TreeImageForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.TreeView treeView1;

        private void InitializeComponent()
        {
            System.Windows.Forms.TreeNode treeNode1 = new System.Windows.Forms.TreeNode("Apple");
            System.Windows.Forms.TreeNode treeNode2 = new System.Windows.Forms.TreeNode("Banana");
            System.Windows.Forms.TreeNode treeNode3 = new System.Windows.Forms.TreeNode("Fruits", new System.Windows.Forms.TreeNode[] {
            treeNode1,
            treeNode2});
            System.Windows.Forms.TreeNode treeNode4 = new System.Windows.Forms.TreeNode("Carrot");
            this.treeView1 = new System.Windows.Forms.TreeView();
            this.SuspendLayout();
            //
            // treeView1
            //
            treeNode1.ImageKey = "apple.png";
            treeNode1.Name = "nodeApple";
            treeNode1.SelectedImageKey = "apple_sel.png";
            treeNode2.ImageIndex = 1;
            treeNode2.Name = "nodeBanana";
            treeNode2.SelectedImageIndex = 2;
            treeNode3.ImageKey = "folder.png";
            treeNode3.Name = "nodeFruits";
            treeNode4.Name = "nodeCarrot";
            this.treeView1.Location = new System.Drawing.Point(12, 12);
            this.treeView1.Name = "treeView1";
            this.treeView1.Nodes.AddRange(new System.Windows.Forms.TreeNode[] {
            treeNode3,
            treeNode4});
            this.treeView1.Size = new System.Drawing.Size(200, 300);
            this.treeView1.TabIndex = 0;
            //
            // TreeImageForm
            //
            this.ClientSize = new System.Drawing.Size(284, 361);
            this.Controls.Add(this.treeView1);
            this.Name = "TreeImageForm";
            this.Text = "Tree Image Form";
            this.ResumeLayout(false);
        }
    }
}
