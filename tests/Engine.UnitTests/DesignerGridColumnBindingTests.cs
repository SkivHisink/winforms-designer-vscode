using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerGridColumnBindingTests
{
    private const string Source = """
        namespace Demo
        {
            partial class GridForm
            {
                private System.Windows.Forms.DataGridView grid;
                private System.Windows.Forms.DataGridViewTextBoxColumn amountColumn;

                private void InitializeComponent()
                {
                    this.grid = new System.Windows.Forms.DataGridView();
                    this.amountColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
                    this.grid.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] {
                        this.amountColumn});
                    this.amountColumn.DataPropertyName = "Amount";
                    this.amountColumn.DefaultCellStyle.Format = "N2";
                    this.amountColumn.DefaultCellStyle.Alignment = System.Windows.Forms.DataGridViewContentAlignment.MiddleRight;
                    this.amountColumn.DefaultCellStyle.NullValue = "(none)";
                    this.amountColumn.HeaderText = "Amount";
                    this.amountColumn.Name = "amountColumn";
                }
            }
        }
        """;

    [Fact]
    public void ReadsBindingAndManagedCellStyle()
    {
        var result = DesignerGridColumnEditor.ListColumns(Source, "grid");

        Assert.True(result.Ok, result.Reason);
        var column = Assert.Single(result.Columns);
        Assert.Equal("Amount", column.DataPropertyName);
        Assert.Equal("N2", column.Format);
        Assert.Equal("MiddleRight", column.Alignment);
        Assert.Equal("(none)", column.NullValue);
    }

    [Fact]
    public void WritesBindingAndManagedCellStyleThroughTheColumnGate()
    {
        var edit = DesignerGridColumnEditor.SetColumns(Source, "grid",
        [
            new GridColumnItem
            {
                Id = "amountColumn",
                HeaderText = "Total",
                Width = 140,
                DataPropertyName = "Total",
                Format = "C2",
                Alignment = "BottomRight",
                NullValue = "n/a",
            },
        ]);

        Assert.NotEqual(EditMode.Failed, edit.Mode);
        Assert.True(DesignerGridColumnEditor.OnlyColumnsChanged(Source, edit.NewText, "grid"));
        Assert.Contains("""this.amountColumn.DataPropertyName = "Total";""", edit.NewText);
        Assert.Contains("""this.amountColumn.DefaultCellStyle.Format = "C2";""", edit.NewText);
        Assert.Contains("DataGridViewContentAlignment.BottomRight", edit.NewText);
        Assert.Contains("""this.amountColumn.DefaultCellStyle.NullValue = "n/a";""", edit.NewText);
    }

    [Fact]
    public void RefusesUnsupportedCellStyleAndAlignment()
    {
        string unsupported = Source.Replace(
            """this.amountColumn.DefaultCellStyle.Format = "N2";""",
            """this.amountColumn.DefaultCellStyle.BackColor = System.Drawing.Color.Red;""");
        Assert.False(DesignerGridColumnEditor.ListColumns(unsupported, "grid").Ok);

        var edit = DesignerGridColumnEditor.SetColumns(Source, "grid",
        [
            new GridColumnItem { Id = "amountColumn", Alignment = "Sideways" },
        ]);
        Assert.Equal(EditMode.Failed, edit.Mode);
    }

    /// <summary>An explicit `NullValue = null` is a deliberate value the string-based column model cannot express:
    /// folding it into "" made the writer omit the assignment, so editing an UNRELATED property (HeaderText, Format)
    /// silently deleted the user's statement. Fail closed on both the read and the write side instead.</summary>
    [Fact]
    public void RefusesAColumnWhoseNullValueIsExplicitlyNull()
    {
        string explicitNull = Source.Replace(
            """this.amountColumn.DefaultCellStyle.NullValue = "(none)";""",
            "this.amountColumn.DefaultCellStyle.NullValue = null;");

        var listed = DesignerGridColumnEditor.ListColumns(explicitNull, "grid");
        Assert.False(listed.Ok);
        Assert.Contains("explicitly null", listed.Reason);

        var edit = DesignerGridColumnEditor.SetColumns(explicitNull, "grid",
        [
            new GridColumnItem { Id = "amountColumn", HeaderText = "Amount due" },
        ]);
        Assert.Equal(EditMode.Failed, edit.Mode);
        Assert.Contains("explicitly null", edit.Reason);
    }
}
