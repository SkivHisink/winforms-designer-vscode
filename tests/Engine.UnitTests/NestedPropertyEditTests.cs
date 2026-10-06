using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Linq;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

/// <summary>
/// Nested property editing — a DevExpress button's `ImageOptions.Location` is the motivating case: the grid used to
/// show such rows as read-only text. Describe offers an editor (NestedEditable) exactly where VS writes a nested
/// assignment, and the splice writes exactly `this.button1.ImageOptions.Location = …;` and nothing else.
/// </summary>
public sealed class NestedPropertyEditTests
{
    // ---- describe: offered exactly where VS writes a nested assignment ----

    [Fact]
    public void Describe_ContentHopLeaves_AreNestedEditable_WithEnumAndStandardValues()
    {
        var options = Prop(Describe(), nameof(NestedEditComponent.ImageOptions));

        var location = Child(options.Properties!, "Location");
        Assert.Equal("ImageOptions.Location", location.PropertyPath);
        Assert.True(location.NestedEditable);
        Assert.True(location.IsEnum);
        Assert.Equal("Default", location.Value);
        Assert.True(location.StandardValuesExclusive);
        Assert.Contains("MiddleLeft", location.StandardValues!);

        var glyph = Child(options.Properties!, "AllowGlyphSkinning");
        Assert.True(glyph.NestedEditable);
        Assert.False(glyph.IsEnum);

        Assert.True(Child(options.Properties!, "Caption").NestedEditable);
        // a Content hop below the first one keeps the chain editable (3 segments)
        var mode = Child(Child(options.Properties!, "Inner").Properties!, "Mode");
        Assert.Equal("ImageOptions.Inner.Mode", mode.PropertyPath);
        Assert.True(mode.NestedEditable);
    }

    [Fact]
    public void Describe_LeavesTheHostCannotWriteAsALiteral_StayReadOnlyMetadata()
    {
        var options = Prop(Describe(), nameof(NestedEditComponent.ImageOptions));
        Assert.False(Child(options.Properties!, "Flags").NestedEditable);       // [Flags] needs the flags editor
        Assert.False(Child(options.Properties!, "Offset").NestedEditable);      // complex value, not a literal
        Assert.False(Child(options.Properties!, "Locked").NestedEditable);      // [ReadOnly]
        Assert.False(Child(options.Properties!, "Count").NestedEditable);       // getter-only
        Assert.False(Child(options.Properties!, "Inner").NestedEditable);       // a hop is not a leaf
    }

    [Fact]
    public void Describe_HopsVsDoesNotWriteThrough_OfferNoNestedEditor()
    {
        var component = Describe();
        // not serialized as Content: VS never writes `this.x.NotContent.Location = …`
        Assert.All(Prop(component, nameof(NestedEditComponent.NotContent)).Properties!, p => Assert.False(p.NestedEditable));
        // a converter's synthetic descriptors are not CLR members no C# assignment can reach
        Assert.All(Prop(component, nameof(NestedEditComponent.Synthetic)).Properties!, p => Assert.False(p.NestedEditable));
    }

    [Fact]
    public void Describe_UsesTheDeclaredTypeAndAStableObject_NotWhatTheRuntimeHappensToReturn()
    {
        var component = Describe();
        var polymorphic = Prop(component, nameof(NestedEditComponent.Polymorphic));
        Assert.True(Child(polymorphic.Properties!, "Location").NestedEditable);  // declared on the base
        Assert.False(Child(polymorphic.Properties!, "Extra").NestedEditable);    // only on the runtime subtype (CS1061)
        Assert.All(Prop(component, nameof(NestedEditComponent.Fresh)).Properties!, p => Assert.False(p.NestedEditable));
        Assert.All(Prop(component, nameof(NestedEditComponent.Hiding)).Properties!, p => Assert.False(p.NestedEditable)); // CS0176
    }

    [Fact]
    public void Describe_OffersALeafOnlyWhenSourceAndTheLiveObjectBindTheSameMember()
    {
        var component = Describe();
        // `new` re-declaration with the same name and type: two members, the source and the canvas would diverge
        Assert.False(Child(Prop(component, nameof(NestedEditComponent.NewHidden)).Properties!, "Count").NestedEditable);
        // an override is the same slot: the compiled assignment dispatches to it
        Assert.True(Child(Prop(component, nameof(NestedEditComponent.Overridden)).Properties!, "Count").NestedEditable);
        // a static field hides the inherited instance property
        Assert.False(Child(Prop(component, nameof(NestedEditComponent.FieldHidden)).Properties!, "Count").NestedEditable);
    }

    [Theory]
    [InlineData("if (true) { this.button1.ImageOptions.Count += 1; }")]
    [InlineData("if (true) { this.button1.ImageOptions.Count = 9; }")]
    [InlineData("this.button1.Tag = this.button1.ImageOptions.Count = 9;")]
    [InlineData("if (true) { this.button1.ImageOptions.@Count += 1; }")] // an escaped identifier binds the same member
    [InlineData("this.button1.ImageOptions.@Count = 9;")]
    [InlineData("if (true) { this.button1.ImageOptions.Count++; }")]
    [InlineData("--this.button1.ImageOptions.Count;")]
    [InlineData("this.button1!.ImageOptions.Count++;")]                       // null-forgiving is the same receiver
    [InlineData("((Demo.Options)this.button1.ImageOptions).Count = 9;")]       // a receiver the splice cannot follow
    public void Apply_RefusesWhenTheTargetIsAlsoWrittenWhereTheSpliceCannotSee(string hidden)
    {
        string src = Source
            .Replace("this.button1.ImageOptions.Location = Demo.Loc.Default;", "this.button1.ImageOptions.Count = 1;")
            .Replace("this.button2.Text = \"Two\";", "this.button2.Text = \"Two\";\n            " + hidden);
        var r = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "button1", "ImageOptions.Count", "7", src);
        Assert.False(r.Safe);
        Assert.Null(r.NewText);
    }

    [Theory]
    [InlineData("this.button1.Tag = this.button1.ImageOptions = new Demo.Options();")]
    [InlineData("if (true) { this.button1.ImageOptions = new Demo.Options(); }")]
    [InlineData("if (true) { this.button1.@ImageOptions = new Demo.Options(); }")]
    [InlineData("((Demo.Button)this.button1).ImageOptions = new Demo.Options();")]
    public void Apply_RefusesAnObjectReplacementHiddenInAnExpressionOrBlock(string replacement)
    {
        string src = Source.Replace("this.button2.Text = \"Two\";", "this.button2.Text = \"Two\";\n            " + replacement);
        var r = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "button1", "ImageOptions.Location", "Demo.Loc.TopCenter", src);
        Assert.False(r.Safe);
        Assert.Contains("replaces", r.Reason);
    }

    [Theory]
    [InlineData("Vendor.ImageLocation", true)]
    [InlineData("Evil.Run()", false)]
    [InlineData("Vendor.class", false)]
    [InlineData("Vendor.Outer+Inner", false)]
    [InlineData("", false)]
    public void PlainDottedName_GatesTheEnumSpellingTheHostMayWrite(string name, bool expected) =>
        Assert.Equal(expected, NestedPropertyPath.IsPlainDottedName(name));

    // ---- splice: exactly the nested target, nothing else ----

    // LF regardless of how the checkout writes this file: the expectations below spell their newlines as "\n".
    private static readonly string Source = """
        namespace Demo
        {
            partial class Form1 : System.Windows.Forms.Form
            {
                private System.Windows.Forms.Button button1;
                private System.Windows.Forms.Button button2;

                private void InitializeComponent()
                {
                    this.button1 = new System.Windows.Forms.Button();
                    this.button2 = new System.Windows.Forms.Button();
                    this.button1.ImageOptions.Location = Demo.Loc.Default;
                    this.button1.Name = "button1";
                    this.button2.Name = "button2";
                    this.button2.Text = "Two";
                    this.Controls.Add(this.button1);
                    this.Controls.Add(this.button2);
                }
            }
        }
        """.ReplaceLineEndings("\n");

    [Fact]
    public void Apply_ReplacesTheExistingNestedAssignment_Only()
    {
        var r = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "button1", "ImageOptions.Location",
            "Demo.Loc.MiddleLeft", Source);
        Assert.True(r.Safe, r.Reason);
        Assert.Equal(EditMode.Replace, r.Mode);
        Assert.Equal(Source.Replace("ImageOptions.Location = Demo.Loc.Default", "ImageOptions.Location = Demo.Loc.MiddleLeft"), r.NewText);
    }

    [Fact]
    public void Apply_InsertsAMissingNestedAssignment_InTheOwnersGroup()
    {
        var r = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "button2", "ImageOptions.Location",
            "Demo.Loc.TopCenter", Source);
        Assert.True(r.Safe, r.Reason);
        Assert.Equal(EditMode.Insert, r.Mode);
        string expected = Source.Replace(
            "this.button2.Text = \"Two\";\n",
            "this.button2.Text = \"Two\";\n            this.button2.ImageOptions.Location = Demo.Loc.TopCenter;\n");
        Assert.Equal(expected, r.NewText);
    }

    [Theory]
    [InlineData("button1", "ImageOptions", "true")]                         // one segment is not a nested path
    [InlineData("button1", "A.B.C.D.E", "true")]                            // deeper than the bound
    [InlineData("button1", "Image Options.Location", "true")]               // not identifiers
    [InlineData("button1", "ImageOptions.class", "true")]                   // keyword
    [InlineData("button1", "ImageOptions.Location", "1; this.button2.Text = \"x\"")] // statement injection
    [InlineData("button1", "ImageOptions.Location", "this.button2.Text = \"x\"")]    // nested assignment
    [InlineData("button1", "ImageOptions.Location", "Evil.Run().Good")]     // invocation smuggled as an enum
    [InlineData("button1", "ImageOptions.Location", "this.button2")]        // a reference, not a literal
    [InlineData("button1", "ImageOptions.Location", "1 + 1")]               // an operator, not a literal
    [InlineData("ghost", "ImageOptions.Location", "true")]                  // not a current-source field
    [InlineData("button1.Panel1", "ImageOptions.Location", "true")]         // owner must be one field
    public void Apply_RefusesEverythingOutsideTheBoundedRoute(string component, string path, string value)
    {
        var r = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", component, path, value, Source);
        Assert.False(r.Safe);
        Assert.Null(r.NewText);
    }

    [Fact]
    public void Apply_RefusesACompoundAssignment_WhichIsNotASet()
    {
        string src = Source.Replace("this.button1.ImageOptions.Location = Demo.Loc.Default;", "this.button1.ImageOptions.Count += 1;");
        var r = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "button1", "ImageOptions.Count", "3", src);
        Assert.False(r.Safe);
        Assert.Contains("+=", r.Reason);
    }

    [Theory]
    [InlineData("this.button1.ImageOptions = new Demo.Options();")]
    [InlineData("this.button1.ImageOptions.Inner = new Demo.Inner();")]
    public void Apply_RefusesWhenTheSourceReplacesAnObjectOnThePath(string replacement)
    {
        string src = Source.Replace("this.button2.Text = \"Two\";", "this.button2.Text = \"Two\";\n            " + replacement);
        var r = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "button1", "ImageOptions.Inner.Mode", "Demo.Loc.TopCenter", src);
        Assert.False(r.Safe);
        Assert.Contains("replaces", r.Reason);
    }

    // The grid describes the constructed control, the compiled assignment binds on the field's declared type: a field
    // declared as a base (which a subtype's `new` member could hide) is refused, as is one never constructed here.
    [Theory]
    [InlineData("private System.Windows.Forms.ButtonBase button1;", "this.button1 = new System.Windows.Forms.Button();")]
    [InlineData("private System.Windows.Forms.Button button1;", "this.button1 = CreateButton();")]
    [InlineData("private global::Button button1;", "this.button1 = new Button();")] // differently qualified: may be another type
    public void Apply_RefusesAFieldThatIsNotTypeCertain(string declaration, string creation)
    {
        string src = Source
            .Replace("private System.Windows.Forms.Button button1;", declaration)
            .Replace("this.button1 = new System.Windows.Forms.Button();", creation);
        var r = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "button1", "ImageOptions.Location", "Demo.Loc.TopCenter", src);
        Assert.False(r.Safe);
        Assert.Contains("exact type", r.Reason);
    }

    [Fact]
    public void Apply_RootOwnedNestedSet_InsertsIntoTheRootGroupThenReplaces()
    {
        string src = Source.Replace("this.Controls.Add(this.button1);", "this.Name = \"Form1\";\n            this.Controls.Add(this.button1);");
        var inserted = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "this", "Appearance.Caption", "\"Hello\"", src);
        Assert.True(inserted.Safe, inserted.Reason);
        Assert.Equal(EditMode.Insert, inserted.Mode);
        Assert.Contains("this.Name = \"Form1\";\n            this.Appearance.Caption = \"Hello\";\n", inserted.NewText);

        var replaced = DesignerRenderer.ApplyNestedPropertyEdit("Form1.Designer.cs", "this", "Appearance.Caption", "\"Bye\"", inserted.NewText);
        Assert.True(replaced.Safe, replaced.Reason);
        Assert.Equal(EditMode.Replace, replaced.Mode);
        Assert.Equal(inserted.NewText!.Replace("\"Hello\"", "\"Bye\""), replaced.NewText);
    }

    // ---- fixtures ----

    private static ComponentInfo Describe()
    {
        var root = new NestedEditComponent();
        using var container = new Container();
        container.Add(root, "root");
        var host = new TestDesignerHost(container, root);
        var component = DesignerDescribe.DescribeComponent(host, nameof(NestedEditComponent), new HashSet<(IComponent, string)>(), "this");
        Assert.NotNull(component);
        return component!;
    }

    private static WinFormsDesigner.Engine.PropertyInfo Prop(ComponentInfo component, string name) =>
        Assert.Single(component.Properties, p => p.Name == name);

    private static ExpandablePropertyInfo Child(IEnumerable<ExpandablePropertyInfo> properties, string name) =>
        Assert.Single(properties, p => p.Name == name);
}

public enum NestedImageLocation { Default, MiddleLeft, MiddleCenter, TopCenter }

[Flags]
public enum NestedGlyphFlags { None = 0, Left = 1, Right = 2 }

public sealed class NestedEditComponent : Component
{
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedImageOptions ImageOptions { get; } = new();

    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedImageOptions NotContent { get; } = new();

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(SyntheticChildrenConverter))]
    public NestedImageOptions Synthetic { get; } = new();

    // declared as the base, returns a subtype: only the base members can be written in C#
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedBaseOptions Polymorphic { get; } = new NestedDerivedOptions();

    // a fresh object per read: an edit on it is lost
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedInnerOptions Fresh => new();

    // the derived type hides the instance member with a static one: C# cannot write it through an instance
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedHidingDerived Hiding { get; } = new();

    // declared as the base, the runtime subtype re-declares Count with `new`: source writes the base member, the
    // descriptor would write the derived one
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedNewBase NewHidden { get; } = new NestedNewDerived();

    // the same shape with an override: one slot, so source and canvas agree
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedVirtualBase Overridden { get; } = new NestedVirtualDerived();

    // a static FIELD hides the inherited instance property (CS0176 for an instance access)
    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedFieldHiderDerived FieldHidden { get; } = new();
}

public class NestedNewBase
{
    public int Count { get; set; }
}

public sealed class NestedNewDerived : NestedNewBase
{
    public new int Count { get; set; }
}

public class NestedVirtualBase
{
    public virtual int Count { get; set; }
}

public sealed class NestedVirtualDerived : NestedVirtualBase
{
    private int _count;
    public override int Count { get => _count; set => _count = value; }
}

public class NestedFieldHiderBase
{
    public int Count { get; set; }
}

public sealed class NestedFieldHiderDerived : NestedFieldHiderBase
{
#pragma warning disable CA2211 // the hiding static field IS the fixture
    public static new int Count;
#pragma warning restore CA2211
}

public class NestedBaseOptions
{
    public NestedImageLocation Location { get; set; }
}

public sealed class NestedDerivedOptions : NestedBaseOptions
{
    public bool Extra { get; set; }
}

public class NestedHidingBase
{
    public NestedImageLocation Mode { get; set; }
}

public sealed class NestedHidingDerived : NestedHidingBase
{
    public static new NestedImageLocation Mode { get; set; }
}

public sealed class NestedImageOptions
{
    public NestedImageLocation Location { get; set; }
    public bool AllowGlyphSkinning { get; set; }
    public string Caption { get; set; } = "";
    public NestedGlyphFlags Flags { get; set; }
    public Point Offset { get; set; }
    [ReadOnly(true)]
    public string Locked { get; set; } = "";
    public int Count => 3;

    [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
    [TypeConverter(typeof(ExpandableObjectConverter))]
    public NestedInnerOptions Inner { get; } = new();
}

public sealed class NestedInnerOptions
{
    public NestedImageLocation Mode { get; set; }
}

/// <summary>Projects a descriptor that is not a CLR member of the value (a design-time-only row).</summary>
public sealed class SyntheticChildrenConverter : TypeConverter
{
    public override bool GetPropertiesSupported(ITypeDescriptorContext? context) => true;

    public override PropertyDescriptorCollection GetProperties(ITypeDescriptorContext? context, object value, Attribute[]? attributes) =>
        new(new PropertyDescriptor[] { new SyntheticDescriptor() });

    private sealed class SyntheticDescriptor : PropertyDescriptor
    {
        public SyntheticDescriptor() : base("Projected", Array.Empty<Attribute>()) { }
        public override Type ComponentType => typeof(NestedImageOptions);
        public override bool IsReadOnly => false;
        public override Type PropertyType => typeof(NestedImageLocation);
        public override bool CanResetValue(object component) => false;
        public override object? GetValue(object? component) => NestedImageLocation.Default;
        public override void ResetValue(object component) { }
        public override void SetValue(object? component, object? value) { }
        public override bool ShouldSerializeValue(object component) => false;
    }
}
