namespace SampleApp
{
    partial class TabForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.TabControl tabControl1;
        private System.Windows.Forms.TabPage tabPage1;
        private System.Windows.Forms.TabPage tabPage2;
        private System.Windows.Forms.Button pageButton1;
        private System.Windows.Forms.Label pageLabel2;

        private void InitializeComponent()
        {
            this.tabControl1 = new System.Windows.Forms.TabControl();
            this.tabPage1 = new System.Windows.Forms.TabPage();
            this.tabPage2 = new System.Windows.Forms.TabPage();
            this.pageButton1 = new System.Windows.Forms.Button();
            this.pageLabel2 = new System.Windows.Forms.Label();
            this.tabControl1.SuspendLayout();
            this.tabPage1.SuspendLayout();
            this.tabPage2.SuspendLayout();
            this.SuspendLayout();
            //
            // tabControl1
            //
            this.tabControl1.Controls.Add(this.tabPage1);
            this.tabControl1.Controls.Add(this.tabPage2);
            this.tabControl1.Location = new System.Drawing.Point(12, 12);
            this.tabControl1.Name = "tabControl1";
            this.tabControl1.SelectedIndex = 0;
            this.tabControl1.Size = new System.Drawing.Size(400, 200);
            this.tabControl1.TabIndex = 0;
            //
            // tabPage1
            //
            this.tabPage1.Controls.Add(this.pageButton1);
            this.tabPage1.Location = new System.Drawing.Point(4, 24);
            this.tabPage1.Name = "tabPage1";
            this.tabPage1.Size = new System.Drawing.Size(392, 172);
            this.tabPage1.TabIndex = 0;
            this.tabPage1.Text = "Page 1";
            //
            // tabPage2
            //
            this.tabPage2.Controls.Add(this.pageLabel2);
            this.tabPage2.Location = new System.Drawing.Point(4, 24);
            this.tabPage2.Name = "tabPage2";
            this.tabPage2.Size = new System.Drawing.Size(392, 172);
            this.tabPage2.TabIndex = 1;
            this.tabPage2.Text = "Page 2";
            //
            // pageButton1
            //
            this.pageButton1.Location = new System.Drawing.Point(10, 10);
            this.pageButton1.Name = "pageButton1";
            this.pageButton1.Size = new System.Drawing.Size(80, 30);
            this.pageButton1.TabIndex = 0;
            this.pageButton1.Text = "On Page 1";
            //
            // pageLabel2
            //
            this.pageLabel2.AutoSize = true;
            this.pageLabel2.Location = new System.Drawing.Point(10, 10);
            this.pageLabel2.Name = "pageLabel2";
            this.pageLabel2.Text = "On Page 2";
            //
            // TabForm
            //
            this.ClientSize = new System.Drawing.Size(424, 224);
            this.Controls.Add(this.tabControl1);
            this.Name = "TabForm";
            this.Text = "Tab Form";
            this.tabControl1.ResumeLayout(false);
            this.tabPage1.ResumeLayout(false);
            this.tabPage2.ResumeLayout(false);
            this.ResumeLayout(false);
        }
    }
}
