namespace WinFormsDesigner.Samples
{
    // Fixture for collection AddRange (ListView Columns): the interpreter resolves the collection and adds
    // each referenced ColumnHeader, so the form is fully representable (round-trip safe) AND the columns
    // actually render. (ListView serializes cleanly on .NET 9 — unlike ToolStrip/MenuStrip.)
    partial class ListViewForm
    {
        private void InitializeComponent()
        {
            this.listView1 = new System.Windows.Forms.ListView();
            this.colName = new System.Windows.Forms.ColumnHeader();
            this.colSize = new System.Windows.Forms.ColumnHeader();
            this.SuspendLayout();
            this.listView1.Columns.AddRange(new System.Windows.Forms.ColumnHeader[] {
            this.colName,
            this.colSize});
            this.listView1.Location = new System.Drawing.Point(16, 16);
            this.listView1.Name = "listView1";
            this.listView1.Size = new System.Drawing.Size(360, 180);
            this.listView1.View = System.Windows.Forms.View.Details;
            this.colName.Text = "Name";
            this.colName.Width = 220;
            this.colSize.Text = "Size";
            this.colSize.Width = 120;
            this.Controls.Add(this.listView1);
            this.ClientSize = new System.Drawing.Size(400, 220);
            this.Name = "ListViewForm";
            this.Text = "ListViewForm";
            this.ResumeLayout(false);
        }

        private System.Windows.Forms.ListView listView1;
        private System.Windows.Forms.ColumnHeader colName;
        private System.Windows.Forms.ColumnHeader colSize;
    }
}
