namespace SampleApp
{
    partial class S083BindingForm
    {
        private System.ComponentModel.IContainer components;
        private System.Windows.Forms.BindingSource customerBindingSource;
        private System.Windows.Forms.TextBox nameTextBox;

        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.customerBindingSource = new System.Windows.Forms.BindingSource(this.components);
            this.nameTextBox = new System.Windows.Forms.TextBox();
            ((System.ComponentModel.ISupportInitialize)(this.customerBindingSource)).BeginInit();
            this.SuspendLayout();
            this.customerBindingSource.DataSource = typeof(SampleApp.Customer);
            this.nameTextBox.Location = new System.Drawing.Point(12, 12);
            this.nameTextBox.Name = "nameTextBox";
            this.nameTextBox.Size = new System.Drawing.Size(220, 23);
            this.ClientSize = new System.Drawing.Size(248, 56);
            this.Controls.Add(this.nameTextBox);
            this.Name = "S083BindingForm";
            this.Text = "Customer";
            ((System.ComponentModel.ISupportInitialize)(this.customerBindingSource)).EndInit();
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
