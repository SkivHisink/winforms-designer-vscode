namespace SampleApp
{
    partial class TwoTreeForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.TreeView treeLeft;
        private System.Windows.Forms.TreeView treeRight;

        private void InitializeComponent()
        {
            System.Windows.Forms.TreeNode treeNode1 = new System.Windows.Forms.TreeNode("Left-A");
            System.Windows.Forms.TreeNode treeNode2 = new System.Windows.Forms.TreeNode("Left-B", new System.Windows.Forms.TreeNode[] {
            treeNode1});
            System.Windows.Forms.TreeNode treeNode3 = new System.Windows.Forms.TreeNode("Right-A");
            this.treeLeft = new System.Windows.Forms.TreeView();
            this.treeRight = new System.Windows.Forms.TreeView();
            this.SuspendLayout();
            //
            // treeLeft
            //
            treeNode1.Name = "leftA";
            treeNode2.Name = "leftB";
            this.treeLeft.Location = new System.Drawing.Point(12, 12);
            this.treeLeft.Name = "treeLeft";
            this.treeLeft.Nodes.AddRange(new System.Windows.Forms.TreeNode[] {
            treeNode2});
            this.treeLeft.Size = new System.Drawing.Size(120, 200);
            this.treeLeft.TabIndex = 0;
            //
            // treeRight
            //
            treeNode3.Name = "rightA";
            this.treeRight.Location = new System.Drawing.Point(150, 12);
            this.treeRight.Name = "treeRight";
            this.treeRight.Nodes.AddRange(new System.Windows.Forms.TreeNode[] {
            treeNode3});
            this.treeRight.Size = new System.Drawing.Size(120, 200);
            this.treeRight.TabIndex = 1;
            //
            // TwoTreeForm
            //
            this.ClientSize = new System.Drawing.Size(284, 261);
            this.Controls.Add(this.treeRight);
            this.Controls.Add(this.treeLeft);
            this.Name = "TwoTreeForm";
            this.Text = "Two Tree Form";
            this.ResumeLayout(false);
        }
    }
}
