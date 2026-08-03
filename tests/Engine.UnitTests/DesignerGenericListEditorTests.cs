using System.Linq;
using WinFormsDesigner.Engine;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;

namespace Engine.UnitTests;

public sealed class DesignerGenericListEditorTests
{
    private const string EnumSource = """
        namespace Demo
        {
            partial class Form1
            {
                private Demo.ListHost listHost;
                private Demo.ListHost otherHost;

                private void InitializeComponent()
                {
                    this.listHost = new Demo.ListHost();
                    this.otherHost = new Demo.ListHost();
                    this.listHost.Anchors.AddRange(new System.Windows.Forms.AnchorStyles[] {
                        System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left,
                        System.Windows.Forms.AnchorStyles.Bottom});
                    this.listHost.Anchors.Add(System.Windows.Forms.AnchorStyles.Right);
                    this.otherHost.Anchors.Add(System.Windows.Forms.AnchorStyles.Top);
                    this.listHost.Name = "listHost";
                }
            }
        }
        """;

    [Fact]
    public void ReadsTypedArrayAddRangeAndScalarAddForFlagsEnum()
    {
        var result = DesignerGenericListEditor.ListItems(
            EnumSource,
            "listHost",
            "Anchors",
            "System.Windows.Forms.AnchorStyles");

        Assert.True(result.Ok, result.Reason);
        Assert.Equal(["Top, Left", "Bottom", "Right"], result.Items);
    }

    [Fact]
    public void RewritesTypedEnumCollectionAndLeavesOtherStatementsUntouched()
    {
        var edit = DesignerGenericListEditor.SetItems(
            EnumSource,
            "listHost",
            "Anchors",
            "System.Windows.Forms.AnchorStyles",
            ["Left", "Top, Right"]);

        Assert.True(edit.Safe, edit.Reason);
        Assert.NotNull(edit.NewText);
        Assert.True(DesignerGenericListEditor.OnlyGenericListChanged(
            EnumSource,
            edit.NewText,
            "listHost",
            "Anchors",
            "System.Windows.Forms.AnchorStyles"));
        Assert.Contains("new System.Windows.Forms.AnchorStyles[] { System.Windows.Forms.AnchorStyles.Left, System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Right }", edit.NewText);
        Assert.DoesNotContain("this.listHost.Anchors.Add(System.Windows.Forms.AnchorStyles.Right);", edit.NewText);
        Assert.Contains("this.otherHost.Anchors.Add(System.Windows.Forms.AnchorStyles.Top);", edit.NewText);
        Assert.Contains("this.listHost.Name = \"listHost\";", edit.NewText);
    }

    [Fact]
    public void ReadsAndRewritesNonGenericObjectArrayStringCollection()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private Demo.ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new Demo.ListHost();
                        this.listHost.Items.AddRange(new object[] { "one", "two" });
                    }
                }
            }
            """;

        var listed = DesignerGenericListEditor.ListItems(source, "listHost", "Items", "System.String");

        Assert.True(listed.Ok, listed.Reason);
        Assert.Equal(["one", "two"], listed.Items);

        var edit = DesignerGenericListEditor.SetItems(
            source,
            "listHost",
            "Items",
            "System.String",
            ["alpha", "x\"); this.other.Text = \"owned"]);

        Assert.True(edit.Safe, edit.Reason);
        Assert.NotNull(edit.NewText);
        Assert.Contains("new object[]", edit.NewText);
        Assert.Contains("\\\"owned", edit.NewText);
        Assert.DoesNotContain("this.other.Text = \"owned\";", edit.NewText);
    }

    [Fact]
    public void ReadsAndWritesPrimitiveItems()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private Demo.ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new Demo.ListHost();
                        this.listHost.Numbers.Add(-1);
                        this.listHost.Numbers.AddRange(new int[] { 2, 3 });
                    }
                }
            }
            """;

        var listed = DesignerGenericListEditor.ListItems(source, "listHost", "Numbers", "System.Int32");
        Assert.True(listed.Ok, listed.Reason);
        Assert.Equal(["-1", "2", "3"], listed.Items);

        var edit = DesignerGenericListEditor.SetItems(source, "listHost", "Numbers", "System.Int32", ["4", "-5"]);
        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("new int[] { 4, -5 }", edit.NewText);
    }

    [Fact]
    public void ReadsAndWritesComplexDesignerValueConverterItems()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private Demo.ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new Demo.ListHost();
                        this.listHost.Points.AddRange(new System.Drawing.Point[] { new System.Drawing.Point(12, 34) });
                    }
                }
            }
            """;

        var listed = DesignerGenericListEditor.ListItems(source, "listHost", "Points", "System.Drawing.Point");
        Assert.True(listed.Ok, listed.Reason);
        Assert.Equal(["12, 34"], listed.Items);

        var edit = DesignerGenericListEditor.SetItems(source, "listHost", "Points", "System.Drawing.Point", ["5, 6"]);
        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("new System.Drawing.Point[]", edit.NewText);
        Assert.Contains("new System.Drawing.Point(5, 6)", edit.NewText);
    }

    [Fact]
    public void RefusesSourceExpressionsOutsideTheAdapter()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private Demo.ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new Demo.ListHost();
                        this.listHost.Numbers.Add(System.DateTime.Now.Day);
                    }
                }
            }
            """;

        var listed = DesignerGenericListEditor.ListItems(source, "listHost", "Numbers", "System.Int32");

        Assert.False(listed.Ok);
        Assert.Contains("unsupported", listed.Reason);
    }

    [Fact]
    public void RefusesInvalidInvariantValuesInsteadOfInterpolatingSource()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private Demo.ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new Demo.ListHost();
                        this.listHost.Numbers.Add(1);
                    }
                }
            }
            """;

        var edit = DesignerGenericListEditor.SetItems(
            source,
            "listHost",
            "Numbers",
            "System.Int32",
            ["1); this.evil = 1"]);

        Assert.False(edit.Safe);
        Assert.Null(edit.NewText);
        Assert.Contains("invalid item value", edit.Reason);
    }

    [Fact]
    public void PreservesTargetTrailingCommentsWhenReplacingFirstTarget()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private Demo.ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new Demo.ListHost();
                        this.listHost.Items.Add("old"); // keep
                        this.listHost.Name = "listHost";
                    }
                }
            }
            """;

        var edit = DesignerGenericListEditor.SetItems(source, "listHost", "Items", "System.String", ["new"]);

        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("""this.listHost.Items.Add("new"); // keep""", edit.NewText);
        Assert.True(DesignerGenericListEditor.OnlyGenericListChanged(source, edit.NewText!, "listHost", "Items", "System.String"));
    }

    [Fact]
    public void WritesInterfaceOnlyIListWithAddAndProducesSemanticallyCompilableSource()
    {
        const string source = """
            using System.Collections.Generic;
            using System.ComponentModel;

            namespace Demo
            {
                sealed class ListHost
                {
                    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
                    public IList<int> Numbers { get; } = new List<int>();
                    public string Name { get; set; } = "";
                }

                partial class Form1
                {
                    private ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new ListHost();
                        this.listHost.Name = "listHost";
                    }
                }
            }
            """;

        var edit = DesignerGenericListEditor.SetItems(source, "listHost", "Numbers", "System.Int32", ["4", "-5"]);

        Assert.True(edit.Safe, edit.Reason);
        Assert.Contains("this.listHost.Numbers.Add(4);", edit.NewText);
        Assert.Contains("this.listHost.Numbers.Add(-5);", edit.NewText);
        Assert.DoesNotContain("Numbers.AddRange", edit.NewText);

        var platformAssemblies = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))!
            .Split(Path.PathSeparator)
            .Select(path => MetadataReference.CreateFromFile(path));
        var compilation = CSharpCompilation.Create(
            "GenericIListDesignerSource",
            [CSharpSyntaxTree.ParseText(edit.NewText!)],
            platformAssemblies,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
        using var output = new MemoryStream();
        var emit = compilation.Emit(output);

        Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics));
    }

    [Fact]
    public void RefusesRewriteThatWouldDropCommentFromRemovedTarget()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private Demo.ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new Demo.ListHost();
                        this.listHost.Items.Add("one");
                        this.listHost.Items.Add("two"); // do not drop
                    }
                }
            }
            """;

        var edit = DesignerGenericListEditor.SetItems(source, "listHost", "Items", "System.String", ["merged"]);

        Assert.False(edit.Safe);
        Assert.Null(edit.NewText);
        Assert.Contains("non-target", edit.Reason);
    }

    [Fact]
    public void EnforcesBoundsAndExactTypeAllowlist()
    {
        const string source = """
            namespace Demo
            {
                partial class Form1
                {
                    private Demo.ListHost listHost;

                    private void InitializeComponent()
                    {
                        this.listHost = new Demo.ListHost();
                        this.listHost.Items.Add("one");
                    }
                }
            }
            """;

        var tooMany = Enumerable.Repeat("x", DesignerGenericListEditor.MaxItems + 1).ToArray();
        var countEdit = DesignerGenericListEditor.SetItems(source, "listHost", "Items", "System.String", tooMany);
        Assert.False(countEdit.Safe);
        Assert.Contains("item count exceeds", countEdit.Reason);

        var typeResult = DesignerGenericListEditor.ListItems(source, "listHost", "Items", "Demo.CustomType");
        Assert.False(typeResult.Ok);
        Assert.Contains("unsupported item type", typeResult.Reason);
    }
}
