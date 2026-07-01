namespace SampleApp
{
    partial class GridForm
    {
        private System.ComponentModel.IContainer components = null;
        private System.Windows.Forms.DataGridView dataGridView1;
        private System.Windows.Forms.DataGridViewTextBoxColumn nameColumn;
        private System.Windows.Forms.DataGridViewTextBoxColumn valueColumn;
        private System.Windows.Forms.BindingSource bindingSource1;
        private System.Windows.Forms.Button refreshButton;

        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.dataGridView1 = new System.Windows.Forms.DataGridView();
            this.nameColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.valueColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.bindingSource1 = new System.Windows.Forms.BindingSource(this.components);
            this.refreshButton = new System.Windows.Forms.Button();
            ((System.ComponentModel.ISupportInitialize)(this.dataGridView1)).BeginInit();
            ((System.ComponentModel.ISupportInitialize)(this.bindingSource1)).BeginInit();
            this.SuspendLayout();
            //
            // dataGridView1
            //
            this.dataGridView1.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] {
            this.nameColumn,
            this.valueColumn});
            this.dataGridView1.Location = new System.Drawing.Point(12, 12);
            this.dataGridView1.Name = "dataGridView1";
            this.dataGridView1.Size = new System.Drawing.Size(360, 180);
            this.dataGridView1.TabIndex = 0;
            //
            // nameColumn
            //
            this.nameColumn.HeaderText = "Name";
            this.nameColumn.Name = "nameColumn";
            //
            // valueColumn
            //
            this.valueColumn.HeaderText = "Value";
            this.valueColumn.Name = "valueColumn";
            //
            // refreshButton
            //
            this.refreshButton.Location = new System.Drawing.Point(12, 200);
            this.refreshButton.Name = "refreshButton";
            this.refreshButton.Size = new System.Drawing.Size(90, 28);
            this.refreshButton.Text = "Refresh";
            //
            // GridForm
            //
            this.ClientSize = new System.Drawing.Size(384, 241);
            this.Controls.Add(this.dataGridView1);
            this.Controls.Add(this.refreshButton);
            this.Name = "GridForm";
            this.Text = "Grid Form";
            ((System.ComponentModel.ISupportInitialize)(this.dataGridView1)).EndInit();
            ((System.ComponentModel.ISupportInitialize)(this.bindingSource1)).EndInit();
            this.ResumeLayout(false);
        }
    }
}
