namespace SampleApp
{
    partial class TableLayoutForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.TableLayoutPanel tableLayoutPanel1;
        private System.Windows.Forms.Label cellLabel;
        private System.Windows.Forms.Button cellButton;
        private System.Windows.Forms.TextBox cellText;

        private void InitializeComponent()
        {
            this.tableLayoutPanel1 = new System.Windows.Forms.TableLayoutPanel();
            this.cellLabel = new System.Windows.Forms.Label();
            this.cellButton = new System.Windows.Forms.Button();
            this.cellText = new System.Windows.Forms.TextBox();
            this.tableLayoutPanel1.SuspendLayout();
            this.SuspendLayout();
            //
            // tableLayoutPanel1
            //
            this.tableLayoutPanel1.ColumnCount = 2;
            this.tableLayoutPanel1.Controls.Add(this.cellLabel, 0, 0);
            this.tableLayoutPanel1.Controls.Add(this.cellButton, 1, 0);
            this.tableLayoutPanel1.Controls.Add(this.cellText, 0, 1);
            this.tableLayoutPanel1.Location = new System.Drawing.Point(12, 12);
            this.tableLayoutPanel1.Name = "tableLayoutPanel1";
            this.tableLayoutPanel1.RowCount = 2;
            this.tableLayoutPanel1.Size = new System.Drawing.Size(360, 160);
            this.tableLayoutPanel1.TabIndex = 0;
            //
            // cellLabel
            //
            this.cellLabel.AutoSize = true;
            this.cellLabel.Name = "cellLabel";
            this.cellLabel.Text = "Cell 0,0";
            //
            // cellButton
            //
            this.cellButton.Name = "cellButton";
            this.cellButton.Text = "Cell 1,0";
            //
            // cellText
            //
            this.cellText.Name = "cellText";
            this.cellText.Text = "Cell 0,1";
            //
            // TableLayoutForm
            //
            this.ClientSize = new System.Drawing.Size(384, 200);
            this.Controls.Add(this.tableLayoutPanel1);
            this.Name = "TableLayoutForm";
            this.Text = "Table Layout Form";
            this.tableLayoutPanel1.ResumeLayout(false);
            this.tableLayoutPanel1.PerformLayout();
            this.ResumeLayout(false);
        }
    }
}
