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

    [Theory]
    [InlineData("\r\n")]
    [InlineData("\n")]
    public void PropertyReset_RemovesEveryRootAssignment_AndPreservesOutsideBytesAndStatementOrder(string newline)
    {
        string source = "\uFEFF" + FormSource().Replace("\r", "").Replace("\n", newline)
            .Replace("public string UserCode() => \"keep\";", "public string UserCode() => \"Сохранить 日本語\";")
            .Replace("this.Text = \"Original\";", "this.Text = \"Original\";" + newline + "            this.Text = \"Final\";");

        var result = ResetPlan(source, "this", "Text");

        Assert.True(result.Safe, result.Reason);
        Assert.Equal(EditMode.Replace, result.Mode);
        Assert.True(result.SemanticEquivalence);
        Assert.True(result.OutsideRegionPreserved);
        Assert.Equal(result.LaneASourceText, result.PlannedSourceText);
        Assert.True(DesignerPropertyEditor.OnlyPropertyReset(source, result.PlannedSourceText, "this", "Text"));
        Assert.DoesNotContain("this.Text =", result.ReplacementText);
        Assert.Equal(source[..result.OwnedRegionStart], result.PlannedSourceText[..result.OwnedRegionStart]);
        Assert.Equal(source[result.OwnedRegionEnd..], result.PlannedSourceText[(result.OwnedRegionStart + result.ReplacementText.Length)..]);
        Assert.Contains("this.button1.Name = \"button1\";" + newline, result.ReplacementText);
        Assert.Contains("remove every explicit target assignment", result.NormalizationPreview);
        Assert.Contains("byte for byte and in order", result.NormalizationPreview);
        Assert.StartsWith("\uFEFF", result.PlannedSourceText);
    }

    [Fact]
    public void PropertyReset_ComponentProperty_PreservesResourceStatementsAndUserPartial()
    {
        string source = FormSource().Replace("\r", "").Replace("\n", "\r\n")
            .Replace("this.button1 = new System.Windows.Forms.Button();",
                "System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(CustomerForm));\r\n"
                + "            this.button1 = new System.Windows.Forms.Button();")
            .Replace("this.button1.Name = \"button1\";",
                "this.button1.Name = \"button1\";\r\n"
                + "            this.button1.Text = resources.GetString(\"button1.Text\");\r\n"
                + "            this.button1.Enabled = false;");

        var result = ResetPlan(source, "button1", "Enabled");

        Assert.True(result.Safe, result.Reason);
        Assert.DoesNotContain("this.button1.Enabled", result.ReplacementText);
        Assert.Contains("this.button1.Text = resources.GetString(\"button1.Text\");\r\n", result.ReplacementText);
        Assert.Contains("ComponentResourceManager(typeof(CustomerForm));\r\n", result.ReplacementText);
        Assert.Contains("public string UserCode() => \"keep\";", result.PlannedSourceText);
        Assert.Equal(DesignerPropertyEditor.ResetProperty(source, "button1", "Enabled").NewText, result.PlannedSourceText);
    }

    [Fact]
    public void PropertyReset_AlreadyDefault_IsNotReportedAsAnOperation()
    {
        var result = ResetPlan(FormSource(), "button1", "Enabled");

        Assert.False(result.Safe);
        Assert.Contains("already default", result.Reason);
        Assert.Equal("", result.PlannedSourceText);
        Assert.False(result.SemanticEquivalence);
    }

    [Theory]
    [InlineData("// keep user note\r\n            this.Text = \"Original\";", "comment")]
    [InlineData("#if DEBUG\r\n            this.Text = \"Original\";\r\n            #endif", "directive")]
    [InlineData("this.Text = \"Original\";\r\n            System.Diagnostics.Process.Start(\"calc\");", "unmodeled")]
    [InlineData("this.Text = \"Original\"; this.button1.Enabled = false;", "shares its line")]
    public void PropertyReset_UnknownOrUnownedSource_IsRefusedWithoutAPlan(string replacement, string reason)
    {
        string source = FormSource().Replace("this.Text = \"Original\";", replacement);

        var result = ResetPlan(source, "this", "Text");

        Assert.False(result.Safe);
        Assert.Contains(reason, result.Reason);
        Assert.Equal("", result.PlannedSourceText);
        Assert.Equal("", result.ReplacementText);
    }

    [Fact]
    public void PropertyReset_StaleFingerprint_IsRefused()
    {
        var result = DesignerOwnedRegionSerializer.PlanPropertyReset(new DesignerOwnedRegionPlanRequest
        {
            SourceText = FormSource(),
            ExpectedSourceSha256 = new string('a', 64),
            ComponentName = "this",
            PropertyName = "Text",
        });

        Assert.False(result.Safe);
        Assert.Equal("stale source fingerprint", result.Reason);
        Assert.Equal("", result.PlannedSourceText);
    }

    [Theory]
    [InlineData("button1;Run()", "Text", "invalid component")]
    [InlineData("this", "Text;Run()", "invalid property")]
    [InlineData("button1.Properties", "Caption", "invalid component")]
    public void PropertyReset_InvalidOrNestedIdentifiers_AreRefused(string component, string property, string reason)
    {
        var result = ResetPlan(FormSource(), component, property);

        Assert.False(result.Safe);
        Assert.Contains(reason, result.Reason);
        Assert.Equal("", result.PlannedSourceText);
    }

    [Fact]
    public void BoundedComponentPatch_UnrelatedStringLiteralWhitespaceChange_IsRefused()
    {
        string source = FormSource();
        string proposed = source.Replace("this.button1.Name = \"button1\";", "this.button1.Name = \"buttonOne\";")
            .Replace("this.Text = \"Original\";", "this.Text = \"O riginal\";");

        var result = ComponentPatch(source, proposed);

        Assert.False(result.Safe);
        Assert.Contains("statements outside 'button1' would change or move", result.Reason);
        Assert.Equal("", result.PlannedSourceText);
    }

    [Fact]
    public void BoundedComponentPatch_UnrelatedAssignmentReorder_IsRefused()
    {
        string source = FormSource().Replace("this.Text = \"Original\";",
            "this.Text = \"Original\";\r\n            this.Text = \"Final\";");
        string proposed = source.Replace("this.button1.Name = \"button1\";", "this.button1.Name = \"buttonOne\";")
            .Replace("this.Text = \"Original\";\r\n            this.Text = \"Final\";",
                "this.Text = \"Final\";\r\n            this.Text = \"Original\";");

        var result = ComponentPatch(source, proposed);

        Assert.False(result.Safe);
        Assert.Contains("statements outside 'button1' would change or move", result.Reason);
        Assert.Equal("", result.PlannedSourceText);
    }

    [Fact]
    public void BoundedComponentPatch_UnrelatedFormattingChange_IsRefused()
    {
        string source = FormSource();
        string proposed = source.Replace("this.button1.Name = \"button1\";", "this.button1.Name = \"buttonOne\";")
            .Replace("this.Text = \"Original\";", "this.Text  = \"Original\";");

        var result = ComponentPatch(source, proposed);

        Assert.False(result.Safe);
        Assert.Contains("owned-region violation", result.Reason);
        Assert.Equal("", result.PlannedSourceText);
    }

    private static DesignerOwnedRegionPlanResult ResetPlan(string source, string componentName, string propertyName) =>
        DesignerOwnedRegionSerializer.PlanPropertyReset(new DesignerOwnedRegionPlanRequest
        {
            SourceText = source,
            ExpectedSourceSha256 = DesignerOwnedRegionSerializer.Sha256Hex(source),
            ComponentName = componentName,
            PropertyName = propertyName,
        });

    private static DesignerOwnedRegionPlanResult ComponentPatch(string source, string proposed) =>
        DesignerOwnedRegionSerializer.PlanBoundedComponentPatch(new DesignerOwnedRegionPatchRequest
        {
            SourceText = source,
            ExpectedSourceSha256 = DesignerOwnedRegionSerializer.Sha256Hex(source),
            ProposedSourceText = proposed,
            ComponentName = "button1",
            PatchLabel = "button1.Name",
        });

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
