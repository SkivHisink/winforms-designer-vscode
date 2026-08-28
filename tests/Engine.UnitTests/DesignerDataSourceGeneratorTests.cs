using System;
using System.IO;
using System.Linq;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerDataSourceGeneratorTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "wfd-datasources-" + Guid.NewGuid().ToString("N"));

    public DesignerDataSourceGeneratorTests()
    {
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); } catch { }
    }

    [Fact]
    public void ListDataSources_DiscoversProjectDtoSettingsAndExistingTypedBindingSource()
    {
        var designer = WriteProject(
            dtoSource: """
                namespace DemoApp.Models
                {
                    public sealed class Customer
                    {
                        public string Name { get; set; } = "";
                        public decimal Balance { get; set; }
                        public System.DateTime CreatedOn { get; }
                        public object Unsafe { get; set; } = new object();
                    }
                }
                """,
            designerSource: FormSource(extraFields: "private System.Windows.Forms.BindingSource customerBindingSource;",
                extraStatements: """
                            this.customerBindingSource = new System.Windows.Forms.BindingSource(this.components);
                            this.customerBindingSource.DataSource = typeof(DemoApp.Models.Customer);
                """),
            settings: """
                <?xml version="1.0" encoding="utf-8"?>
                <SettingsFile xmlns="http://schemas.microsoft.com/VisualStudio/2004/01/settings">
                  <Settings>
                    <Setting Name="TitleText" Type="System.String" Scope="User">
                      <Value Profile="(Default)">secret default must not be returned</Value>
                    </Setting>
                  </Settings>
                </SettingsFile>
                """);

        var result = DesignerDataSourceGenerator.ListDataSources(designer, File.ReadAllText(designer));

        Assert.True(result.Ok, result.Reason);
        var schema = Assert.Single(result.Schemas);
        Assert.Equal("Customer", schema.Name);
        Assert.Equal("DemoApp.Models.Customer", schema.TypeName);
        Assert.Contains(schema.Properties, p => p.Name == "Name" && p.TypeName == "System.String" && p.Kind == "text");
        Assert.Contains(schema.Properties, p => p.Name == "Balance" && p.Kind == "number");
        Assert.Contains(schema.Properties, p => p.Name == "CreatedOn" && p.ReadOnly);
        Assert.DoesNotContain(schema.Properties, p => p.Name == "Unsafe");
        Assert.Equal(["customerBindingSource"], schema.ExistingBindingSources);
        Assert.DoesNotContain(result.Schemas, s => s.Name == "Settings");
        var setting = Assert.Single(result.Settings);
        Assert.Equal("TitleText", setting.Name);
        Assert.Equal("System.String", setting.TypeName);
        Assert.DoesNotContain("secret", string.Join("|", setting.Key, setting.Name, setting.TypeName, setting.Scope));
    }

    [Fact(DisplayName = "V2-FND-001-S081 typed DataSet table maps to DataMember source graph")]
    [Trait("V2Scenario", "V2-FND-001-S081")]
    public void TypedDataSet_TableIsDiscoveredAndExistingBindingSourceIsMatchedByDataMember()
    {
        var designer = WriteProject(
            dtoSource: TypedDataSetSource(),
            designerSource: FormSource(
                extraFields: """
                    private DemoApp.Data.StoreDataSet storeDataSet;
                    private System.Windows.Forms.BindingSource customersBindingSource;
                    """,
                extraStatements: """
                            this.storeDataSet = new DemoApp.Data.StoreDataSet();
                            this.customersBindingSource = new System.Windows.Forms.BindingSource(this.components);
                            this.customersBindingSource.DataMember = "Customers";
                            this.customersBindingSource.DataSource = this.storeDataSet;
                    """),
            settings: null);

        var result = DesignerDataSourceGenerator.ListDataSources(designer, File.ReadAllText(designer));

        Assert.True(result.Ok, result.Reason);
        var schema = Assert.Single(result.Schemas);
        Assert.Equal("typedDataSetTable", schema.SourceKind);
        Assert.Equal("DemoApp.Data.StoreDataSet", schema.TypeName);
        Assert.Equal("Customers", schema.Name);
        Assert.Equal("Customers", schema.DataMember);
        Assert.Equal(["customersBindingSource"], schema.ExistingBindingSources);
        Assert.Collection(schema.Properties,
            p => { Assert.Equal("Id", p.Name); Assert.Equal("number", p.Kind); },
            p => { Assert.Equal("Name", p.Name); Assert.Equal("text", p.Kind); });
    }

    [Fact]
    public void TypedDataSet_GridGenerationCreatesRealDataSetAndDataMemberGraph()
    {
        var designer = WriteProject(
            dtoSource: TypedDataSetSource(),
            designerSource: FormSource(),
            settings: null);
        string source = File.ReadAllText(designer);
        var catalog = DesignerDataSourceGenerator.ListDataSources(designer, source);
        var schema = Assert.Single(catalog.Schemas);

        var edit = DesignerDataSourceGenerator.GenerateDataSource(
            designer, schema.Key, "grid", "this", 10, 20, includeNavigator: true, sourceText: source);

        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("private DemoApp.Data.StoreDataSet storeDataSet1;", edit.NewText);
        Assert.Contains("this.storeDataSet1 = new DemoApp.Data.StoreDataSet();", edit.NewText);
        Assert.Contains("this.customersBindingSource1.DataMember = \"Customers\";", edit.NewText);
        Assert.Contains("this.customersBindingSource1.DataSource = this.storeDataSet1;", edit.NewText);
        Assert.DoesNotContain("typeof(DemoApp.Data.StoreDataSet)", edit.NewText);
        Assert.Contains("this.idColumn1.DataPropertyName = \"Id\";", edit.NewText);
        Assert.Contains("storeDataSet1", edit.CreatedIds);
        Assert.Contains("customersBindingSource1", edit.CreatedIds);
        Assert.Contains("customersDataGridView1", edit.CreatedIds);
    }

    [Fact]
    public void ListDataSources_FailsClosedWhenNoSupportedProjectFilesExist()
    {
        var designer = WriteProject(
            dtoSource: "namespace DemoApp { public sealed class Empty { public object Value { get; set; } = new object(); } }",
            designerSource: FormSource(),
            settings: null);

        var result = DesignerDataSourceGenerator.ListDataSources(designer, File.ReadAllText(designer));

        Assert.False(result.Ok);
        Assert.Contains("no supported", result.Reason);
    }

    [Fact(DisplayName = "V2-FND-001-S084 unsupported provider returns a typed no-mutation refusal")]
    [Trait("V2Scenario", "V2-FND-001-S084")]
    public void UnsupportedProviderDataSource_IsNotExposedAndCannotGenerate()
    {
        var designer = WriteProject(
            dtoSource: """
                namespace DemoApp.Data
                {
                    public sealed class CustomerContext
                    {
                        public string ConnectionString { get; set; } = "";
                        public Microsoft.EntityFrameworkCore.DbSet<Customer> Customers { get; set; }
                    }

                    public sealed class Customer
                    {
                        public object Payload { get; set; } = new object();
                    }
                }
                """,
            designerSource: FormSource(),
            settings: null);
        string source = File.ReadAllText(designer);

        var catalog = DesignerDataSourceGenerator.ListDataSources(designer, source);
        var edit = DesignerDataSourceGenerator.GenerateDataSource(
            designer, "schema:DemoApp.Data.CustomerContext", "grid", "this", 0, 0, includeNavigator: false, sourceText: source);

        Assert.False(catalog.Ok);
        Assert.Equal("UNSUPPORTED_DATA_PROVIDER", catalog.RefusalCode);
        Assert.Contains("unsupported data provider", catalog.Reason);
        Assert.Contains("DemoApp.Data.CustomerContext", catalog.Reason);
        Assert.False(edit.Safe);
        Assert.Equal("UNSUPPORTED_DATA_PROVIDER", edit.RefusalCode);
        Assert.Contains("unsupported data provider", edit.Reason);
        Assert.Null(edit.NewText);
        Assert.Empty(edit.CreatedIds);
    }

    [Fact]
    public void ListDataSources_UsesSdkDefaultCompileMembershipAndCompileRemove()
    {
        var designer = WriteProject(
            dtoSource: "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(),
            settings: null,
            extraProjectItems: """<Compile Remove="Removed.cs" />""");
        File.WriteAllText(Path.Combine(_dir, "Removed.cs"),
            "namespace DemoApp.Models { public sealed class Removed { public string Name { get; set; } = \"\"; } }");
        Directory.CreateDirectory(Path.Combine(_dir, "obj"));
        File.WriteAllText(Path.Combine(_dir, "obj", "Generated.cs"),
            "namespace DemoApp.Models { public sealed class Generated { public string Name { get; set; } = \"\"; } }");

        var result = DesignerDataSourceGenerator.ListDataSources(designer, File.ReadAllText(designer));

        Assert.True(result.Ok, result.Reason);
        var schema = Assert.Single(result.Schemas);
        Assert.Equal("Customer", schema.Name);
    }

    [Fact]
    public void ListDataSources_HonorsDisabledDefaultCompileItemsAndExplicitIncludes()
    {
        string models = Path.Combine(_dir, "Models");
        Directory.CreateDirectory(models);
        var designer = WriteProject(
            dtoSource: "namespace DemoApp.Models { public sealed class Ignored { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(),
            settings: null,
            enableDefaultCompileItems: false,
            extraProjectItems: """
                <Compile Include="Models\Customer.cs" />
                <Compile Include="Models\Removed.cs" />
                <Compile Remove="Models\Removed.cs" />
                """);
        File.WriteAllText(Path.Combine(models, "Customer.cs"),
            "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }");
        File.WriteAllText(Path.Combine(models, "Removed.cs"),
            "namespace DemoApp.Models { public sealed class Removed { public string Name { get; set; } = \"\"; } }");

        var result = DesignerDataSourceGenerator.ListDataSources(designer, File.ReadAllText(designer));

        Assert.True(result.Ok, result.Reason);
        var schema = Assert.Single(result.Schemas);
        Assert.Equal("Customer", schema.Name);
    }

    [Fact]
    public void ListDataSources_ClassicProjectUsesExplicitCompileItemsIncludingLinkedOutOfRoot()
    {
        string projectDir = Path.Combine(_dir, "ClassicProject");
        string sharedDir = Path.Combine(_dir, "Shared");
        Directory.CreateDirectory(projectDir);
        Directory.CreateDirectory(sharedDir);
        string designer = Path.Combine(projectDir, "Form1.Designer.cs");
        File.WriteAllText(Path.Combine(projectDir, "ClassicProject.csproj"), """
            <Project ToolsVersion="15.0">
              <ItemGroup>
                <Compile Include="Form1.Designer.cs" />
                <Compile Include="..\Shared\Customer.cs">
                  <Link>Customer.cs</Link>
                </Compile>
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(designer, FormSource());
        File.WriteAllText(Path.Combine(projectDir, "Ignored.cs"),
            "namespace DemoApp.Models { public sealed class Ignored { public string Name { get; set; } = \"\"; } }");
        File.WriteAllText(Path.Combine(sharedDir, "Customer.cs"),
            "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }");

        var result = DesignerDataSourceGenerator.ListDataSources(designer, File.ReadAllText(designer));

        Assert.True(result.Ok, result.Reason);
        var schema = Assert.Single(result.Schemas);
        Assert.Equal("Customer", schema.Name);
    }

    [Fact]
    public void ListDataSources_FailsClosedForConditionalCompileMembership()
    {
        var designer = WriteProject(
            dtoSource: "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(),
            settings: null,
            extraProjectItems: """<Compile Remove="MaybeRemoved.cs" Condition="'$(Configuration)' == 'Release'" />""");
        File.WriteAllText(Path.Combine(_dir, "MaybeRemoved.cs"),
            "namespace DemoApp.Models { public sealed class MaybeRemoved { public string Name { get; set; } = \"\"; } }");

        var result = DesignerDataSourceGenerator.ListDataSources(designer, File.ReadAllText(designer));

        Assert.True(result.Ok, result.Reason);
        Assert.Contains(result.Schemas, s => s.Name == "Customer");
        Assert.DoesNotContain(result.Schemas, s => s.Name == "MaybeRemoved");
    }

    [Fact]
    public void ListDataSources_DropsDuplicateTypeIdentity()
    {
        var designer = WriteProject(
            dtoSource: "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(),
            settings: null);
        File.WriteAllText(Path.Combine(_dir, "Customer.Duplicate.cs"),
            "namespace DemoApp.Models { public sealed class Customer { public string Other { get; set; } = \"\"; } }");

        var result = DesignerDataSourceGenerator.ListDataSources(designer, File.ReadAllText(designer));

        Assert.False(result.Ok);
        Assert.Contains("no supported", result.Reason);
    }

    [Fact]
    public void GenerateDataSource_CreatesDetailSurfaceAndRefusesStaleSchemaWithoutPartialText()
    {
        var designer = WriteProject(
            dtoSource: """
                namespace DemoApp.Models
                {
                    public sealed class Customer
                    {
                        public string Name { get; set; } = "";
                        public bool Active { get; set; }
                    }
                }
                """,
            designerSource: FormSource(),
            settings: null);
        string source = File.ReadAllText(designer);
        var key = DesignerDataSourceGenerator.ListDataSources(designer, source).Schemas.Single().Key;

        var edit = DesignerDataSourceGenerator.GenerateDataSource(
            designer, key, "detail", "this", 10, 20, includeNavigator: true, sourceText: source);

        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("customerBindingSource1", edit.CreatedIds);
        Assert.Contains("""this.customerBindingSource1.DataSource = typeof(DemoApp.Models.Customer);""", edit.NewText);
        Assert.Contains("""this.nameTextBox1.DataBindings.Add(new System.Windows.Forms.Binding("Text", this.customerBindingSource1, "Name", true, System.Windows.Forms.DataSourceUpdateMode.OnPropertyChanged));""", edit.NewText);
        Assert.Contains("""this.activeCheckBox1.DataBindings.Add(new System.Windows.Forms.Binding("Checked", this.customerBindingSource1, "Active", true, System.Windows.Forms.DataSourceUpdateMode.OnPropertyChanged));""", edit.NewText);
        Assert.Contains("this.bindingNavigator1.BindingSource = this.customerBindingSource1;", edit.NewText);

        var stale = DesignerDataSourceGenerator.GenerateDataSource(
            designer, "schema:DemoApp.Models.Missing", "detail", "this", 0, 0, false, sourceText: source);

        Assert.False(stale.Safe);
        Assert.Null(stale.NewText);
        Assert.Empty(stale.CreatedIds);
    }

    [Fact]
    public void GenerateDataSource_HonorsReadOnlyPropertiesInDetailAndNewGrid()
    {
        var designer = WriteProject(
            dtoSource: """
                namespace DemoApp.Models
                {
                    public sealed class Customer
                    {
                        public string Name { get; set; } = "";
                        public System.DateTime CreatedOn { get; }
                    }
                }
                """,
            designerSource: FormSource(),
            settings: null);
        string source = File.ReadAllText(designer);
        var key = DesignerDataSourceGenerator.ListDataSources(designer, source).Schemas.Single().Key;

        var detail = DesignerDataSourceGenerator.GenerateDataSource(
            designer, key, "detail", "this", 10, 20, false, sourceText: source);

        Assert.True(detail.Safe, detail.Reason);
        Assert.Contains("this.createdOnDateTimePicker1.Enabled = false;", detail.NewText);
        Assert.Contains("""this.createdOnDateTimePicker1.DataBindings.Add(new System.Windows.Forms.Binding("Value", this.customerBindingSource1, "CreatedOn", true, System.Windows.Forms.DataSourceUpdateMode.Never));""", detail.NewText);
        Assert.DoesNotContain("""CreatedOn", true, System.Windows.Forms.DataSourceUpdateMode.OnPropertyChanged""", detail.NewText);

        var grid = DesignerDataSourceGenerator.GenerateDataSource(
            designer, key, "grid", "this", 10, 20, false, sourceText: source);

        Assert.True(grid.Safe, grid.Reason);
        Assert.Contains("this.createdOnColumn1.ReadOnly = true;", grid.NewText);
        Assert.DoesNotContain("this.nameColumn1.ReadOnly = true;", grid.NewText);
    }

    [Fact]
    public void GenerateDataSource_RefusesNonContainerParent()
    {
        var designer = WriteProject(
            dtoSource: "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(
                extraFields: "private System.Windows.Forms.TextBox nameTextBox;",
                extraStatements: "        this.nameTextBox = new System.Windows.Forms.TextBox();"),
            settings: null);
        string source = File.ReadAllText(designer);
        var key = DesignerDataSourceGenerator.ListDataSources(designer, source).Schemas.Single().Key;

        var edit = DesignerDataSourceGenerator.GenerateDataSource(
            designer, key, "detail", "nameTextBox", 0, 0, false, sourceText: source);

        Assert.False(edit.Safe);
        Assert.Contains("not a supported container", edit.Reason);
        Assert.Null(edit.NewText);
    }

    [Fact]
    public void GenerateDataSource_AppendsMissingColumnsToSupportedExistingGridAndPreservesExistingColumns()
    {
        var designer = WriteProject(
            dtoSource: """
                namespace DemoApp.Models
                {
                    public sealed class Customer
                    {
                        public string Name { get; set; } = "";
                        public decimal Balance { get; }
                    }
                }
                """,
            designerSource: FormSource(
                extraFields: """
                    private System.Windows.Forms.BindingSource customerBindingSource;
                    private System.Windows.Forms.DataGridView customerGrid;
                    private System.Windows.Forms.DataGridViewTextBoxColumn nameColumn;
                    """,
                extraStatements: """
                            this.customerBindingSource = new System.Windows.Forms.BindingSource(this.components);
                            this.customerGrid = new System.Windows.Forms.DataGridView();
                            this.nameColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
                            this.customerBindingSource.DataSource = typeof(DemoApp.Models.Customer);
                            this.customerGrid.Columns.AddRange(new System.Windows.Forms.DataGridViewColumn[] {
                                this.nameColumn});
                            this.customerGrid.DataSource = this.customerBindingSource;
                            this.nameColumn.DataPropertyName = "Name";
                            this.nameColumn.HeaderText = "Customer name";
                            this.nameColumn.Name = "nameColumn";
                    """),
            settings: null);
        string source = File.ReadAllText(designer);
        var key = DesignerDataSourceGenerator.ListDataSources(designer, source).Schemas.Single().Key;

        var edit = DesignerDataSourceGenerator.GenerateDataSource(
            designer, key, "grid", "this", 0, 0, false, "customerBindingSource", "customerGrid", source);

        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("""this.nameColumn.HeaderText = "Customer name";""", edit.NewText);
        Assert.Contains("""this.dataGridViewColumn1.DataPropertyName = "Balance";""", edit.NewText);
        Assert.Contains("this.dataGridViewColumn1.ReadOnly = true;", edit.NewText);
        Assert.Contains("System.Windows.Forms.DataGridViewContentAlignment.MiddleRight", edit.NewText);
    }

    [Fact]
    public void GenerateDataSource_AppendsToExistingGridAndCreatesBindingSourceWhenMissing()
    {
        var designer = WriteProject(
            dtoSource: "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(
                extraFields: "private System.Windows.Forms.DataGridView customerGrid;",
                extraStatements: "        this.customerGrid = new System.Windows.Forms.DataGridView();"),
            settings: null);
        string source = File.ReadAllText(designer);
        var key = DesignerDataSourceGenerator.ListDataSources(designer, source).Schemas.Single().Key;

        var edit = DesignerDataSourceGenerator.GenerateDataSource(
            designer, key, "grid", "this", 0, 0, false, existingGridId: "customerGrid", sourceText: source);

        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("customerBindingSource1", edit.CreatedIds);
        Assert.Contains("""this.customerBindingSource1.DataSource = typeof(DemoApp.Models.Customer);""", edit.NewText);
        Assert.Contains("this.customerGrid.DataSource = this.customerBindingSource1;", edit.NewText);
        Assert.Contains("""this.dataGridViewColumn1.DataPropertyName = "Name";""", edit.NewText);
    }

    [Fact]
    public void GenerateDataSource_RefusesUnsafeExistingGridWithoutPartialText()
    {
        var designer = WriteProject(
            dtoSource: "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(
                extraFields: """
                    private System.Windows.Forms.BindingSource customerBindingSource;
                    private System.Windows.Forms.DataGridView customerGrid;
                    private System.Windows.Forms.DataGridViewTextBoxColumn nameColumn;
                    """,
                extraStatements: """
                            this.customerBindingSource = new System.Windows.Forms.BindingSource(this.components);
                            this.customerGrid = new System.Windows.Forms.DataGridView();
                            this.nameColumn = new System.Windows.Forms.DataGridViewTextBoxColumn();
                            this.customerBindingSource.DataSource = typeof(DemoApp.Models.Customer);
                            this.customerGrid.Columns.Add(this.nameColumn);
                            this.nameColumn.DataPropertyName = "Name";
                            this.nameColumn.Name = "wrongName";
                    """),
            settings: null);
        string source = File.ReadAllText(designer);
        var key = DesignerDataSourceGenerator.ListDataSources(designer, source).Schemas.Single().Key;

        var edit = DesignerDataSourceGenerator.GenerateDataSource(
            designer, key, "grid", "this", 0, 0, false, "customerBindingSource", "customerGrid", source);

        Assert.False(edit.Safe);
        Assert.Null(edit.NewText);
        Assert.DoesNotContain("dataGridViewColumn", string.Join("|", edit.CreatedIds));
    }

    [Fact]
    public void BindApplicationSetting_UsesCanonicalSettingsPathAndRefusesWrongTarget()
    {
        var designer = WriteProject(
            dtoSource: "namespace DemoApp.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(
                extraFields: """
                    private System.Windows.Forms.TextBox nameTextBox;
                    private System.Windows.Forms.NumericUpDown countBox;
                    """,
                extraStatements: """
                            this.nameTextBox = new System.Windows.Forms.TextBox();
                            this.countBox = new System.Windows.Forms.NumericUpDown();
                    """),
            settings: """
                <SettingsFile xmlns="http://schemas.microsoft.com/VisualStudio/2004/01/settings">
                  <Settings>
                    <Setting Name="TitleText" Type="System.String" Scope="User"><Value Profile="(Default)">hidden</Value></Setting>
                  </Settings>
                </SettingsFile>
                """);
        string source = File.ReadAllText(designer);
        string key = DesignerDataSourceGenerator.ListDataSources(designer, source).Settings.Single().Key;

        var edit = DesignerDataSourceGenerator.BindApplicationSetting(designer, key, "nameTextBox", source);

        Assert.True(edit.Safe, edit.Reason);
        Assert.Equal("Text", edit.BoundProperty);
        Assert.Contains("global::DemoApp.Properties.Settings.Default, \"TitleText\"", edit.NewText);
        Assert.DoesNotContain("hidden", edit.NewText);

        var wrong = DesignerDataSourceGenerator.BindApplicationSetting(designer, key, "countBox", source);
        Assert.False(wrong.Safe);
        Assert.Null(wrong.NewText);
    }

    [Fact]
    public void BindApplicationSetting_UsesProjectSettingsNamespaceNotFormNamespace()
    {
        var designer = WriteProject(
            dtoSource: "namespace Product.Models { public sealed class Customer { public string Name { get; set; } = \"\"; } }",
            designerSource: FormSource(
                namespaceName: "Product.UI",
                extraFields: "private System.Windows.Forms.TextBox nameTextBox;",
                extraStatements: "        this.nameTextBox = new System.Windows.Forms.TextBox();"),
            settings: """
                <SettingsFile xmlns="http://schemas.microsoft.com/VisualStudio/2004/01/settings">
                  <Settings>
                    <Setting Name="TitleText" Type="System.String" Scope="User"><Value Profile="(Default)">hidden</Value></Setting>
                  </Settings>
                </SettingsFile>
                """,
            rootNamespace: "Product");
        string source = File.ReadAllText(designer);
        string key = DesignerDataSourceGenerator.ListDataSources(designer, source).Settings.Single().Key;

        var edit = DesignerDataSourceGenerator.BindApplicationSetting(designer, key, "nameTextBox", source);

        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("global::Product.Properties.Settings.Default", edit.NewText);
        Assert.DoesNotContain("global::Product.UI.Properties.Settings.Default", edit.NewText);
    }

    private string WriteProject(
        string dtoSource,
        string designerSource,
        string? settings,
        string rootNamespace = "DemoApp",
        bool enableDefaultCompileItems = true,
        string extraProjectItems = "")
    {
        File.WriteAllText(Path.Combine(_dir, "DemoApp.csproj"), $$"""
            <Project Sdk="Microsoft.NET.Sdk">
              <PropertyGroup>
                <TargetFramework>net10.0-windows</TargetFramework>
                <UseWindowsForms>true</UseWindowsForms>
                <RootNamespace>{{rootNamespace}}</RootNamespace>
                <EnableDefaultCompileItems>{{enableDefaultCompileItems.ToString().ToLowerInvariant()}}</EnableDefaultCompileItems>
              </PropertyGroup>
              <ItemGroup>
                {{extraProjectItems}}
              </ItemGroup>
            </Project>
            """);
        File.WriteAllText(Path.Combine(_dir, "Customer.cs"), dtoSource);
        string designer = Path.Combine(_dir, "Form1.Designer.cs");
        File.WriteAllText(designer, designerSource);
        if (settings != null)
        {
            string properties = Path.Combine(_dir, "Properties");
            Directory.CreateDirectory(properties);
            File.WriteAllText(Path.Combine(properties, "Settings.settings"), settings);
            File.WriteAllText(Path.Combine(properties, "Settings.Designer.cs"), $$"""
                namespace {{rootNamespace}}.Properties
                {
                    internal sealed partial class Settings
                    {
                        public string GeneratedSchemaTrap { get; set; } = "";
                    }
                }
                """);
        }
        return designer;
    }

    private static string FormSource(string namespaceName = "DemoApp", string extraFields = "", string extraStatements = "") => $$"""
        namespace {{namespaceName}}
        {
            partial class Form1
            {
                private System.ComponentModel.IContainer components;
        {{extraFields}}

                private void InitializeComponent()
                {
                    this.components = new System.ComponentModel.Container();
        {{extraStatements}}
                    this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
                    this.ClientSize = new System.Drawing.Size(800, 450);
                    this.Text = "Form1";
                }
            }
        }
        """;

    private static string TypedDataSetSource() => """
        namespace DemoApp.Data
        {
            public partial class StoreDataSet : System.Data.DataSet
            {
                public CustomersDataTable Customers { get { return null; } }

                public partial class CustomersDataTable : System.Data.TypedTableBase<CustomersRow>
                {
                }

                public partial class CustomersRow : System.Data.DataRow
                {
                    public int Id { get; set; }
                    public string Name { get; set; }
                }
            }
        }
        """;
}
