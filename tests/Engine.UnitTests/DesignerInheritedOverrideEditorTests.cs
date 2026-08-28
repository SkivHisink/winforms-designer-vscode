using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerInheritedOverrideEditorTests
{
    [Fact]
    public void PublicInheritedField_InsertsDerivedOnlyOverride_BeforeTrailingLayoutCalls()
    {
        var result = Apply(BaseSource);

        Assert.True(result.Safe, result.Reason);
        Assert.Equal(InheritedOverrideEditMode.Insert, result.Mode);
        Assert.Contains("this.inheritedButton.Text = \"Derived\";", result.NewText);
        Assert.True(result.NewText!.IndexOf("this.inheritedButton.Text = \"Derived\";", StringComparison.Ordinal)
            < result.NewText.IndexOf("this.ResumeLayout(false);", StringComparison.Ordinal));
        Assert.Equal("protected System.Windows.Forms.Button currentButton;", Slice(result.NewText, "protected System.Windows.Forms.Button currentButton;"));
        Assert.DoesNotContain("baseButton", result.NewText);
    }

    [Fact]
    public void ProtectedInheritedField_ReplacesExistingDerivedOverrideOnly()
    {
        string source = BaseSource.Replace(
            "this.currentButton.Text = \"Current\";",
            "this.currentButton.Text = \"Current\";\r\n            this.inheritedButton.Text = \"Old\";");

        var result = Apply(source, accessibility: "protected");

        Assert.True(result.Safe, result.Reason);
        Assert.Equal(InheritedOverrideEditMode.Replace, result.Mode);
        Assert.Contains("this.inheritedButton.Text = \"Derived\";", result.NewText);
        Assert.DoesNotContain("this.inheritedButton.Text = \"Old\";", result.NewText);
        Assert.Equal(Prefix(source, "\"Old\""), Prefix(result.NewText!, "\"Derived\""));
        Assert.Equal(Suffix(source, "\"Old\""), Suffix(result.NewText!, "\"Derived\""));
    }

    [Fact]
    public void SameValue_IsSafeNoop_AndPreservesSourceByteForByte()
    {
        string source = BaseSource.Replace(
            "this.currentButton.Text = \"Current\";",
            "this.currentButton.Text = \"Current\";\r\n            this.inheritedButton.Text = \"Derived\";");

        var result = Apply(source);

        Assert.True(result.Safe, result.Reason);
        Assert.Equal(InheritedOverrideEditMode.Noop, result.Mode);
        Assert.Same(source, result.NewText);
    }

    [Theory]
    [InlineData("private")]
    [InlineData("internal")]
    [InlineData("private protected")]
    [InlineData("unknown")]
    public void InaccessibleOrUnknownInheritedField_IsRefusedWithoutMutation(string accessibility)
    {
        var result = Apply(BaseSource, accessibility: accessibility);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("accessible", result.Reason);
    }

    [Theory]
    [InlineData("ThirdParty.XtraButton")]
    [InlineData("unknown")]
    [InlineData("")]
    public void VendorUnresolvedOrUnknownType_IsRefusedWithoutMutation(string fieldType)
    {
        var result = Apply(BaseSource, fieldType: fieldType);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("type", result.Reason);
    }

    [Fact]
    public void ResolvedVendorControlType_AcceptsOnlyMatchingLiveTypeEvidence()
    {
        var request = new InheritedOverrideEditRequest
        {
            SourceText = BaseSource,
            FieldId = "inheritedButton",
            FieldTypeName = typeof(FakeVendor.FancyButton).FullName!,
            EffectiveAccessibility = "protected",
            PropertyName = "Text",
            PropertyTypeName = "System.String",
            ValueExpression = "\"Vendor derived\"",
            ExpectedBaseIdentityToken = "base:v1",
            ObservedBaseIdentityToken = "base:v1",
        };

        var resolved = DesignerInheritedOverrideEditor.TryApply(
            request, typeof(FakeVendor.FancyButton), typeof(FakeVendor.FancyButton));
        var mismatched = DesignerInheritedOverrideEditor.TryApply(
            request, typeof(System.Windows.Forms.Button), typeof(FakeVendor.FancyButton));

        Assert.True(resolved.Safe, resolved.Reason);
        Assert.Contains("this.inheritedButton.Text = \"Vendor derived\";", resolved.NewText);
        Assert.False(mismatched.Safe);
        Assert.Null(mismatched.NewText);
        Assert.Contains("type", mismatched.Reason);
    }

    [Fact]
    public void StaleBaseFingerprint_IsRefusedWithoutMutation()
    {
        var result = Apply(BaseSource, observedToken: "base:v2");

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("token", result.Reason);
    }

    [Theory]
    [InlineData("Text", "System.String", "\"x\"; this.evil = 1")]
    [InlineData("Text", "System.String", "MakeText()")]
    [InlineData("Location", "System.Drawing.Point", "new System.Drawing.Point(this.currentButton.Left, 1)")]
    [InlineData("TabIndex", "System.Int32", "-1")]
    [InlineData("Dock", "System.Windows.Forms.DockStyle", "System.IO.File.Delete")]
    public void UnsafeExpressions_AreRefusedWithoutMutation(string property, string propertyType, string expression)
    {
        var result = Apply(BaseSource, propertyName: property, propertyType: propertyType, valueExpression: expression);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("safe", result.Reason);
    }

    [Fact]
    public void CurrentSourceFieldCollision_IsRefusedWithoutMutation()
    {
        string source = BaseSource.Replace(
            "protected System.Windows.Forms.Button currentButton;",
            "protected System.Windows.Forms.Button currentButton;\r\n        private System.Windows.Forms.Button inheritedButton;");

        var result = Apply(source);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("current source", result.Reason);
    }

    [Fact]
    public void AmbiguousBareAssignment_IsRefusedWithoutMutation()
    {
        string source = BaseSource.Replace(
            "this.currentButton.Text = \"Current\";",
            "this.currentButton.Text = \"Current\";\r\n            inheritedButton.Text = \"Old\";");

        var result = Apply(source);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("ambiguous", result.Reason);
    }

    [Fact]
    public void MultipleExistingAssignments_AreRefusedWithoutMutation()
    {
        string source = BaseSource.Replace(
            "this.currentButton.Text = \"Current\";",
            "this.currentButton.Text = \"Current\";\r\n            this.inheritedButton.Text = \"Old\";\r\n            this.inheritedButton.Text = \"Newer\";");

        var result = Apply(source);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("multiple", result.Reason);
    }

    [Theory]
    [InlineData("if (true) this.inheritedButton.Text = \"Old\";")]
    [InlineData("{ this.inheritedButton.Text = \"Old\"; }")]
    [InlineData("System.Action write = () => this.inheritedButton.Text = \"Old\";")]
    [InlineData("this.inheritedButton.Text += \"Old\";")]
    public void NonCanonicalExistingTargetWrite_IsRefusedWithoutMutation(string statement)
    {
        string source = BaseSource.Replace(
            "this.currentButton.Text = \"Current\";",
            "this.currentButton.Text = \"Current\";\r\n            " + statement);

        var result = Apply(source);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("ambiguous", result.Reason);
    }

    [Fact]
    public void VisualStudioSectionComments_ArePreservedAcrossInsertAndReset()
    {
        string source = BaseSource.Replace(
            "this.currentButton.Text = \"Current\";",
            "//\r\n            // currentButton\r\n            //\r\n            this.currentButton.Text = \"Current\";");

        var result = Apply(source);

        Assert.True(result.Safe, result.Reason);
        Assert.Contains("// currentButton", result.NewText);
        var removed = Remove(result.NewText!);
        Assert.True(removed.Safe, removed.Reason);
        Assert.Equal(source, removed.NewText);
    }

    [Fact]
    public void DirectivesInsideInitializeComponent_AreRefusedWithoutMutation()
    {
        string source = BaseSource.Replace(
            "this.currentButton.Text = \"Current\";",
            "#if DEBUG\r\n            this.currentButton.Text = \"Current\";\r\n            #endif");

        var result = Apply(source);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
        Assert.Contains("directive", result.Reason);
    }

    [Fact]
    public void AllowlistedLayoutExpressions_AreAccepted()
    {
        var location = Apply(BaseSource, propertyName: "Location", propertyType: "System.Drawing.Point",
            valueExpression: "new System.Drawing.Point(7, 9)");
        var size = Apply(BaseSource, propertyName: "Size", propertyType: "System.Drawing.Size",
            valueExpression: "new System.Drawing.Size(90, 24)");
        var anchor = Apply(BaseSource, propertyName: "Anchor", propertyType: "System.Windows.Forms.AnchorStyles",
            valueExpression: "System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Left");
        var dock = Apply(BaseSource, propertyName: "Dock", propertyType: "System.Windows.Forms.DockStyle",
            valueExpression: "System.Windows.Forms.DockStyle.Fill");

        Assert.True(location.Safe, location.Reason);
        Assert.True(size.Safe, size.Reason);
        Assert.True(anchor.Safe, anchor.Reason);
        Assert.True(dock.Safe, dock.Reason);
    }

    [Fact]
    public void Geometry_AllowsNegativeCoordinates_ButRefusesNegativeExtents()
    {
        var location = Apply(BaseSource, propertyName: "Location", propertyType: "System.Drawing.Point",
            valueExpression: "new System.Drawing.Point(-7, 9)");
        var bounds = Apply(BaseSource, propertyName: "Bounds", propertyType: "System.Drawing.Rectangle",
            valueExpression: "new System.Drawing.Rectangle(-7, -9, 90, 24)");
        var negativeSize = Apply(BaseSource, propertyName: "Size", propertyType: "System.Drawing.Size",
            valueExpression: "new System.Drawing.Size(-1, 24)");
        var negativeBoundsWidth = Apply(BaseSource, propertyName: "Bounds", propertyType: "System.Drawing.Rectangle",
            valueExpression: "new System.Drawing.Rectangle(1, 2, -3, 4)");

        Assert.True(location.Safe, location.Reason);
        Assert.True(bounds.Safe, bounds.Reason);
        Assert.False(negativeSize.Safe);
        Assert.False(negativeBoundsWidth.Safe);
    }

    [Theory]
    [InlineData("Anchor", "System.Windows.Forms.AnchorStyles", "System.Windows.Forms.AnchorStyles.NotARealMember")]
    [InlineData("Dock", "System.Windows.Forms.DockStyle", "System.Windows.Forms.DockStyle.NotARealMember")]
    [InlineData("Dock", "System.Windows.Forms.DockStyle", "System.Windows.Forms.DockStyle.Left | System.Windows.Forms.DockStyle.Right")]
    public void EnumOverrides_RefuseUnknownMembersAndNonFlagsCombinations(
        string property, string propertyType, string expression)
    {
        var result = Apply(BaseSource, propertyName: property, propertyType: propertyType, valueExpression: expression);

        Assert.False(result.Safe);
        Assert.Null(result.NewText);
    }

    [Fact]
    public void Reset_RemovesOnlyTheCanonicalDerivedAssignment_AndRestoresOriginalBytes()
    {
        var inserted = Apply(BaseSource);
        Assert.True(inserted.Safe, inserted.Reason);

        var removed = Remove(inserted.NewText!);

        Assert.True(removed.Safe, removed.Reason);
        Assert.Equal(InheritedOverrideEditMode.Remove, removed.Mode);
        Assert.Equal(BaseSource, removed.NewText);
    }

    [Fact]
    public void Reset_IsNoopWithoutAnOverride_AndRefusesStaleOrAmbiguousTargets()
    {
        var noop = Remove(BaseSource);
        Assert.True(noop.Safe, noop.Reason);
        Assert.Equal(InheritedOverrideEditMode.Noop, noop.Mode);
        Assert.Same(BaseSource, noop.NewText);

        string ambiguous = BaseSource.Replace(
            "this.currentButton.Text = \"Current\";",
            "this.currentButton.Text = \"Current\";\r\n            this.inheritedButton.Text = \"One\";\r\n            this.inheritedButton.Text = \"Two\";");
        Assert.False(Remove(ambiguous).Safe);
        Assert.False(Remove(Apply(BaseSource).NewText!, observedToken: "base:v2").Safe);
    }

    private static InheritedOverrideEditResult Apply(
        string source,
        string fieldId = "inheritedButton",
        string fieldType = "System.Windows.Forms.Button",
        string accessibility = "public",
        string propertyName = "Text",
        string propertyType = "System.String",
        string valueExpression = "\"Derived\"",
        string expectedToken = "base:v1",
        string observedToken = "base:v1") =>
        DesignerInheritedOverrideEditor.TryApply(new InheritedOverrideEditRequest
        {
            SourceText = source,
            FieldId = fieldId,
            FieldTypeName = fieldType,
            EffectiveAccessibility = accessibility,
            PropertyName = propertyName,
            PropertyTypeName = propertyType,
            ValueExpression = valueExpression,
            ExpectedBaseIdentityToken = expectedToken,
            ObservedBaseIdentityToken = observedToken,
        });

    private static InheritedOverrideEditResult Remove(
        string source,
        string expectedToken = "base:v1",
        string observedToken = "base:v1") =>
        DesignerInheritedOverrideEditor.TryRemove(new InheritedOverrideEditRequest
        {
            SourceText = source,
            FieldId = "inheritedButton",
            FieldTypeName = "System.Windows.Forms.Button",
            EffectiveAccessibility = "protected",
            PropertyName = "Text",
            PropertyTypeName = "System.String",
            ExpectedBaseIdentityToken = expectedToken,
            ObservedBaseIdentityToken = observedToken,
        });

    private static string Prefix(string source, string marker) =>
        source.Substring(0, source.IndexOf(marker, StringComparison.Ordinal));

    private static string Suffix(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal) + marker.Length;
        return source.Substring(start);
    }

    private static string Slice(string source, string marker)
    {
        int start = source.IndexOf(marker, StringComparison.Ordinal);
        return source.Substring(start, marker.Length);
    }

    private const string BaseSource = """
        namespace Demo
        {
            partial class DerivedForm : BaseForm
            {
                protected System.Windows.Forms.Button currentButton;

                private void InitializeComponent()
                {
                    this.currentButton = new System.Windows.Forms.Button();
                    this.currentButton.Name = "currentButton";
                    this.currentButton.Text = "Current";
                    this.ClientSize = new System.Drawing.Size(240, 90);
                    this.Controls.Add(this.currentButton);
                    this.ResumeLayout(false);
                    this.PerformLayout();
                }
            }
        }
        """;
}
