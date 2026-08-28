using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerOwnedRegionSerializerTests
{
    [Fact]
    public void FormRootProperty_ProducesLaneBPlanEquivalentToLaneA_AndPreservesOutsideBytes()
    {
        string source = FormSource();

        var result = Plan(source, "this", "Text", "\"Renamed\"");

        Assert.True(result.Safe, result.Reason);
        Assert.Equal(EditMode.Replace, result.Mode);
        Assert.True(result.SemanticEquivalence);
        Assert.True(result.OutsideRegionPreserved);
        Assert.Equal(result.LaneASourceText, result.PlannedSourceText);
        Assert.Contains("this.Text = \"Renamed\";", result.ReplacementText);
        Assert.Contains("outsideRegionPreserved=true", result.NormalizationPreview);
        string prefix = source[..result.OwnedRegionStart];
        string suffix = source[result.OwnedRegionEnd..];
        Assert.Equal(prefix, result.PlannedSourceText[..result.OwnedRegionStart]);
        Assert.Equal(suffix, result.PlannedSourceText[(result.OwnedRegionStart + result.ReplacementText.Length)..]);
        Assert.Contains("// outside comment must survive", result.PlannedSourceText);
        Assert.Contains("public string UserCode() => \"keep\";", result.PlannedSourceText);
    }

    [Fact]
    public void UserControlRootProperty_InsertPlan_StaysInsideInitializeComponent()
    {
        string source = UserControlSource();

        var result = Plan(source, "this", "Text", "\"Customer picker\"");

        Assert.True(result.Safe, result.Reason);
        Assert.Equal(EditMode.Insert, result.Mode);
        Assert.Equal(result.LaneASourceText, result.PlannedSourceText);
        Assert.Contains("this.Text = \"Customer picker\";", result.ReplacementText);
        Assert.DoesNotContain("Text = \"Customer picker\"", source[..result.OwnedRegionStart]);
        Assert.DoesNotContain("Text = \"Customer picker\"", source[result.OwnedRegionEnd..]);
    }

    [Fact]
    public void V2_FND_001_S047_CertifiedVendorScalar_ProducesLaneBInsertEquivalentToLaneA()
    {
        string source = """
            namespace FakeVendor
            {
                partial class VendorEditorForm
                {
                    private FakeVendor.VendorEdit vendorEdit1;

                    private void InitializeComponent()
                    {
                        this.vendorEdit1 = new FakeVendor.VendorEdit();
                        this.vendorEdit1.Name = "vendorEdit1";
                        this.Controls.Add(this.vendorEdit1);
                    }
                }
            }
            """.Replace("\n", "\r\n");

        var result = Plan(source, "vendorEdit1", "ComplexValue", "\"Vendor Beta\"");

        Assert.True(result.Safe, result.Reason);
        Assert.Equal(EditMode.Insert, result.Mode);
        Assert.True(result.SemanticEquivalence);
        Assert.True(result.OutsideRegionPreserved);
        Assert.Equal(result.LaneASourceText, result.PlannedSourceText);
        Assert.Contains("this.vendorEdit1.ComplexValue = \"Vendor Beta\";", result.ReplacementText);
    }

    [Fact]
    public void StaleFingerprint_IsRefusedBeforePlanning()
    {
        string source = FormSource();
        var result = DesignerOwnedRegionSerializer.PlanPropertySet(new DesignerOwnedRegionPlanRequest
        {
            SourceText = source,
            ExpectedSourceSha256 = new string('a', 64),
            ComponentName = "this",
            PropertyName = "Text",
            ValueExpression = "\"Changed\"",
        });

        Assert.False(result.Safe);
        Assert.Equal("stale source fingerprint", result.Reason);
        Assert.Equal("", result.PlannedSourceText);
    }

    [Fact]
    public void MultipleInitializeComponentDeclarations_AreRefused()
    {
        string source = FormSource() + """

            namespace Demo
            {
                partial class OtherForm
                {
                    private void InitializeComponent()
                    {
                    }
                }
            }
            """;

        var result = Plan(source, "this", "Text", "\"Changed\"");

        Assert.False(result.Safe);
        Assert.Equal("ambiguous InitializeComponent declarations", result.Reason);
    }

    [Fact]
    public void CommentInsideOwnedRegion_IsRefused()
    {
        string source = FormSource().Replace(
            "            this.Text = \"Original\";",
            "            // user note inside generated region\r\n            this.Text = \"Original\";");

        var result = Plan(source, "this", "Text", "\"Changed\"");

        Assert.False(result.Safe);
        Assert.Contains("comment", result.Reason);
    }

    [Fact]
    public void DirectiveInsideOwnedRegion_IsRefused()
    {
        string source = FormSource().Replace(
            "            this.Text = \"Original\";",
            "            #if DEBUG\r\n            this.Text = \"Original\";\r\n            #endif");

        var result = Plan(source, "this", "Text", "\"Changed\"");

        Assert.False(result.Safe);
        Assert.Contains("directive", result.Reason);
    }

    [Fact]
    public void UnmodeledInitializeComponentStatement_IsRefused()
    {
        string source = FormSource().Replace(
            "            this.Controls.Add(this.button1);",
            "            this.Controls.Add(this.button1);\r\n            System.Diagnostics.Process.Start(\"calc\");");

        var result = Plan(source, "this", "Text", "\"Changed\"");

        Assert.False(result.Safe);
        Assert.Contains("unmodeled statements", result.Reason);
        Assert.Equal("", result.PlannedSourceText);
    }

    private static DesignerOwnedRegionPlanResult Plan(string source, string componentName, string propertyName, string valueExpression) =>
        DesignerOwnedRegionSerializer.PlanPropertySet(new DesignerOwnedRegionPlanRequest
        {
            SourceText = source,
            ExpectedSourceSha256 = DesignerOwnedRegionSerializer.Sha256Hex(source),
            ComponentName = componentName,
            PropertyName = propertyName,
            ValueExpression = valueExpression,
        });

    private static string FormSource() => """
        using System;

        namespace Demo
        {
            // outside comment must survive
            partial class CustomerForm : System.Windows.Forms.Form
            {
                private void InitializeComponent()
                {
                    this.button1 = new System.Windows.Forms.Button();
                    this.button1.Name = "button1";
                    this.Text = "Original";
                    this.Controls.Add(this.button1);
                }

                public string UserCode() => "keep";

                private System.Windows.Forms.Button button1;
            }
        }
        """.Replace("\n", "\r\n");

    private static string UserControlSource() => """
        namespace Demo.Controls
        {
            partial class CustomerPicker : System.Windows.Forms.UserControl
            {
                private System.Windows.Forms.Label label1;

                private void InitializeComponent()
                {
                    this.label1 = new System.Windows.Forms.Label();
                    this.label1.Name = "label1";
                    this.Controls.Add(this.label1);
                }
            }
        }
        """.Replace("\n", "\r\n");
}
