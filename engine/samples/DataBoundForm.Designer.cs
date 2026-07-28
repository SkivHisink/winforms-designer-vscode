namespace WinFormsDesigner.Samples
{
    // v1.2 fixture: a routine data-bound form with a BindingSource, Control.DataBindings, bound grid columns,
    // formatting/cell-style settings, and a component-tray provider.
    partial class DataBoundForm
    {
        private System.ComponentModel.IContainer components;
        private System.Windows.Forms.BindingSource customerBindingSource;
        private System.Windows.Forms.TextBox nameTextBox;
        private System.Windows.Forms.DataGridView customerGrid;
        private System.Windows.Forms.DataGridViewTextBoxColumn nameColumn;
        private System.Windows.Forms.DataGridViewTextBoxColumn amountColumn;
        private System.Windows.Forms.ToolTip toolTip1;

        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.customerBindingSource = new System.Windows.Forms.BindingSource(this.components);
            this.nameTextBox = new System.Windows.Forms.TextBox();
            this.customerGrid = new System.Windows.Forms.DataGridView();
            this.nameColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.amountColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
            this.toolTip1 = new System.Windows.Forms.ToolTip(this.components);
            ((System.ComponentModel.ISupportInitialize)(this.customerBindingSource)).BeginInit();
            ((System.ComponentModel.ISupportInitialize)(this.customerGrid)).BeginInit();
            this.SuspendLayout();
            this.nameTextBox.DataBindings.Add(new System.Windows.Forms.Binding("Text", this.customerBindingSource, "Name", true, System.Windows.Forms.DataSourceUpdateMode.OnPropertyChanged));
            this.nameTextBox.Location = new System.Drawing.Point(12, 12);
            this.nameTextBox.Name = "nameTextBox";
            this.nameTextBox.Size = new System.Drawing.Size(220, 23);
            this.customerGrid.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] {
            this.nameColumn,
            this.amountColumn});
            this.customerGrid.DataSource = this.customerBindingSource;
            this.customerGrid.Location = new System.Drawing.Point(12, 48);
            this.customerGrid.Name = "customerGrid";
            this.customerGrid.Size = new System.Drawing.Size(420, 210);
            this.nameColumn.DataPropertyName = "Name";
            this.nameColumn.HeaderText = "Customer";
            this.nameColumn.Name = "nameColumn";
            this.amountColumn.DataPropertyName = "Amount";
            this.amountColumn.DefaultCellStyle.Alignment = System.Windows.Forms.DataGridViewContentAlignment.MiddleRight;
            this.amountColumn.DefaultCellStyle.Format = "N2";
            this.amountColumn.DefaultCellStyle.NullValue = "(none)";
            this.amountColumn.HeaderText = "Amount";
            this.amountColumn.Name = "amountColumn";
            this.toolTip1.SetToolTip(this.nameTextBox, "Customer name");
            this.ClientSize = new System.Drawing.Size(448, 274);
            this.Controls.Add(this.nameTextBox);
            this.Controls.Add(this.customerGrid);
            this.Name = "DataBoundForm";
            this.Text = "Customers";
            ((System.ComponentModel.ISupportInitialize)(this.customerBindingSource)).EndInit();
            ((System.ComponentModel.ISupportInitialize)(this.customerGrid)).EndInit();
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
