using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerBindingEditorTests
{
    private const string Source = """
        namespace Demo
        {
            partial class CustomerForm
            {
                private System.Windows.Forms.TextBox nameTextBox;
                private System.Windows.Forms.Label amountLabel;
                private System.Windows.Forms.BindingSource customerBindingSource;
                private System.ComponentModel.IContainer components;

                private void InitializeComponent()
                {
                    this.components = new System.ComponentModel.Container();
                    this.nameTextBox = new System.Windows.Forms.TextBox();
                    this.amountLabel = new System.Windows.Forms.Label();
                    this.customerBindingSource = new System.Windows.Forms.BindingSource(this.components);
                    this.customerBindingSource.DataSource = typeof(Demo.Customer);
                    this.nameTextBox.Name = "nameTextBox";
                    this.nameTextBox.DataBindings.Add(new System.Windows.Forms.Binding("Text", this.customerBindingSource, "Name", true));
                    this.amountLabel.DataBindings.Add(new System.Windows.Forms.Binding("Text", this.customerBindingSource, "Amount", true, System.Windows.Forms.DataSourceUpdateMode.Never, null, "N2"));
                    this.Controls.Add(this.nameTextBox);
                    this.Controls.Add(this.amountLabel);
                }
            }
        }
        """;

    [Fact]
    public void ListsCanonicalBindingsAndAvailableSources()
    {
        var result = DesignerBindingEditor.ListBindings(Source, "amountLabel");

        Assert.True(result.Ok, result.Reason);
        var binding = Assert.Single(result.Bindings);
        Assert.Equal("Text", binding.PropertyName);
        Assert.Equal("customerBindingSource", binding.DataSourceId);
        Assert.Equal("Amount", binding.DataMember);
        Assert.True(binding.FormattingEnabled);
        Assert.Equal("Never", binding.UpdateMode);
        Assert.Equal("N2", binding.FormatString);
        var source = Assert.Single(result.Sources);
        Assert.Equal("customerBindingSource", source.Id);
        Assert.Equal("System.Windows.Forms.BindingSource", source.TypeName);
    }

    [Fact]
    public void ReplacesOnlySelectedOwnersBindingStatements()
    {
        var edit = DesignerBindingEditor.SetBindings(Source, "nameTextBox",
        [
            new BindingItem
            {
                PropertyName = "Text",
                DataSourceId = "customerBindingSource",
                DataMember = "DisplayName",
                FormattingEnabled = true,
                UpdateMode = "OnPropertyChanged",
            },
            new BindingItem
            {
                PropertyName = "Tag",
                DataSourceId = "customerBindingSource",
                DataMember = "Id",
                FormattingEnabled = false,
            },
        ]);

        Assert.NotEqual(EditMode.Failed, edit.Mode);
        Assert.True(DesignerBindingEditor.OnlyBindingsChanged(Source, edit.NewText, "nameTextBox"));
        Assert.Contains("""
            this.nameTextBox.DataBindings.Add(new System.Windows.Forms.Binding("Text", this.customerBindingSource, "DisplayName", true, System.Windows.Forms.DataSourceUpdateMode.OnPropertyChanged));
            """, edit.NewText);
        Assert.Contains("""
            this.nameTextBox.DataBindings.Add(new System.Windows.Forms.Binding("Tag", this.customerBindingSource, "Id", false));
            """, edit.NewText);
        Assert.Contains("""
            this.amountLabel.DataBindings.Add(new System.Windows.Forms.Binding("Text", this.customerBindingSource, "Amount", true, System.Windows.Forms.DataSourceUpdateMode.Never, null, "N2"));
            """, edit.NewText);
    }

    [Fact]
    public void SupportsRemovingAllBindingsWithoutTouchingOtherOwners()
    {
        var edit = DesignerBindingEditor.SetBindings(Source, "nameTextBox", []);

        Assert.NotEqual(EditMode.Failed, edit.Mode);
        Assert.True(DesignerBindingEditor.OnlyBindingsChanged(Source, edit.NewText, "nameTextBox"));
        Assert.DoesNotContain("this.nameTextBox.DataBindings.Add", edit.NewText);
        Assert.Contains("this.amountLabel.DataBindings.Add", edit.NewText);
    }

    [Fact]
    public void RefusesUnknownSourcesDuplicatePropertiesAndFormatWithoutFormatting()
    {
        var unknown = DesignerBindingEditor.SetBindings(Source, "nameTextBox",
        [
            new BindingItem { PropertyName = "Text", DataSourceId = "other", DataMember = "Name" },
        ]);
        Assert.Equal(EditMode.Failed, unknown.Mode);
        Assert.Contains("unknown or unsupported data source", unknown.Reason);

        var duplicate = DesignerBindingEditor.SetBindings(Source, "nameTextBox",
        [
            new BindingItem { PropertyName = "Text", DataSourceId = "customerBindingSource" },
            new BindingItem { PropertyName = "Text", DataSourceId = "customerBindingSource" },
        ]);
        Assert.Equal(EditMode.Failed, duplicate.Mode);
        Assert.Contains("duplicate", duplicate.Reason);

        var format = DesignerBindingEditor.SetBindings(Source, "nameTextBox",
        [
            new BindingItem
            {
                PropertyName = "Text",
                DataSourceId = "customerBindingSource",
                FormatString = "N2",
                FormattingEnabled = false,
            },
        ]);
        Assert.Equal(EditMode.Failed, format.Mode);
        Assert.Contains("requires formatting", format.Reason);
    }

    [Fact]
    public void RefusesCustomExpressionsInsteadOfOverwritingThem()
    {
        string customSource = Source.Replace(
            """
            new System.Windows.Forms.Binding("Text", this.customerBindingSource, "Name", true)
            """,
            """
            MakeBinding("Text", this.customerBindingSource)
            """);

        var listed = DesignerBindingEditor.ListBindings(customSource, "nameTextBox");
        Assert.False(listed.Ok);

        var edit = DesignerBindingEditor.SetBindings(customSource, "nameTextBox", []);
        Assert.Equal(EditMode.Failed, edit.Mode);
    }

    [Fact]
    public void GateRejectsChangesOutsideTheTargetBindings()
    {
        var edit = DesignerBindingEditor.SetBindings(Source, "nameTextBox",
        [
            new BindingItem
            {
                PropertyName = "Text",
                DataSourceId = "customerBindingSource",
                DataMember = "Name",
                FormattingEnabled = true,
            },
        ]);
        string tampered = edit.NewText.Replace(
            """this.nameTextBox.Name = "nameTextBox";""",
            """this.nameTextBox.Name = "renamed";""");

        Assert.False(DesignerBindingEditor.OnlyBindingsChanged(Source, tampered, "nameTextBox"));
    }

    [Fact]
    public void ReadsAndWritesBindingSourceDataSource()
    {
        var current = DesignerBindingEditor.GetDataSource(Source, "customerBindingSource");
        Assert.True(current.Ok, current.Reason);
        Assert.Equal("type", current.Kind);
        Assert.Equal("Demo.Customer", current.Value);

        var cleared = DesignerBindingEditor.SetDataSource(Source, "customerBindingSource", "none", "");
        Assert.NotEqual(EditMode.Failed, cleared.Mode);
        Assert.Contains("this.customerBindingSource.DataSource = null;", cleared.NewText);
        Assert.True(DesignerPropertyEditor.OnlyTargetChanged(
            Source, cleared.NewText, "customerBindingSource", "DataSource", cleared.Mode));

        var changedType = DesignerBindingEditor.SetDataSource(Source, "customerBindingSource", "type", "Demo.PreferredCustomer");
        Assert.NotEqual(EditMode.Failed, changedType.Mode);
        Assert.Contains("this.customerBindingSource.DataSource = typeof(Demo.PreferredCustomer);", changedType.NewText);
    }

    [Fact]
    public void DataSourceRefusesExpressionsAndTypeInjection()
    {
        string custom = Source.Replace("typeof(Demo.Customer)", "CreateCustomers()");
        var read = DesignerBindingEditor.GetDataSource(custom, "customerBindingSource");
        Assert.False(read.Ok);

        var injected = DesignerBindingEditor.SetDataSource(Source, "customerBindingSource", "type", "Demo.Customer); this.Tag = 1");
        Assert.Equal(EditMode.Failed, injected.Mode);
        Assert.Contains("invalid DataSource type", injected.Reason);
    }
}
