using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.Drawing;
using System.Linq;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerExpandableMetadataTests
{
    [Fact]
    public void CustomExpandableConverter_EmitsNestedMetadataWithStablePaths()
    {
        var component = DescribeRoot();
        var expandable = Prop(component, nameof(ExpandableMetadataComponent.Expandable));

        Assert.NotNull(expandable.Properties);
        var caption = Child(expandable.Properties!, "Caption");
        Assert.Equal("Expandable.Caption", caption.PropertyPath);
        Assert.Equal("System.String", caption.Type);
        Assert.Equal("hello", caption.Value);
        Assert.False(caption.ReadOnly);
        Assert.False(caption.SourceEditable);
        Assert.Equal("Nested", caption.Category);
        Assert.Equal("Caption text", caption.Description);

        var location = Child(expandable.Properties!, "Location");
        Assert.Equal("Expandable.Location", location.PropertyPath);
        Assert.Equal("3, 4", location.Value);
        Assert.True(location.SourceEditable);

        var locked = Child(expandable.Properties!, "Locked");
        Assert.True(locked.ReadOnly);
        Assert.False(locked.SourceEditable);
    }

    [Fact]
    public void V2_FND_001_S041_NestedValues_IncludeStandardValuesCategoryDescriptionAndRecursiveChildren()
    {
        var component = DescribeRoot();
        var expandable = Prop(component, nameof(ExpandableMetadataComponent.Expandable));
        var nested = Child(expandable.Properties!, "Nested");

        Assert.Equal("Expandable.Nested", nested.PropertyPath);
        Assert.NotNull(nested.Properties);

        var mode = Child(nested.Properties!, "Mode");
        Assert.Equal("Expandable.Nested.Mode", mode.PropertyPath);
        Assert.Equal("Alpha", mode.Value);
        Assert.Equal(new[] { "Alpha", "Beta" }, mode.StandardValues);
        Assert.True(mode.StandardValuesExclusive);
        Assert.Equal("Choice", mode.Category);
        Assert.Equal("Mode choice", mode.Description);

        var size = Child(nested.Properties!, "Size");
        Assert.Equal("Expandable.Nested.Size", size.PropertyPath);
        Assert.Equal("5, 6", size.Value);
        Assert.True(size.SourceEditable);
        Assert.NotNull(size.Properties);
        Assert.Equal("Expandable.Nested.Size.Width", Child(size.Properties!, "Width").PropertyPath);
        Assert.Equal("5", Child(size.Properties!, "Width").Value);
        Assert.Equal("6", Child(size.Properties!, "Height").Value);
    }

    [Fact]
    public void ThrowingConverter_DegradesToOrdinaryPropertyWithoutNestedMetadata()
    {
        var component = DescribeRoot();
        var throwing = Prop(component, nameof(ExpandableMetadataComponent.Throwing));

        Assert.Null(throwing.Properties);
        Assert.False(throwing.PropertiesTruncated);
        Assert.Equal(nameof(ThrowingExpandableObject), throwing.Value);
    }

    [Fact]
    public void V2_FND_001_S044_CycleAndBounds_AreGuarded()
    {
        var component = DescribeRoot();
        var cycle = Prop(component, nameof(ExpandableMetadataComponent.Cycle));

        Assert.NotNull(cycle.Properties);
        var self = Child(cycle.Properties!, "Self");
        Assert.Equal("Cycle.Self", self.PropertyPath);
        Assert.Null(self.Properties);

        var many = Prop(component, nameof(ExpandableMetadataComponent.Many));
        Assert.NotNull(many.Properties);
        Assert.True(many.Properties!.Count <= 64);
        Assert.True(many.PropertiesTruncated);
        Assert.All(many.Properties, p =>
        {
            Assert.True(p.Value == null || p.Value.Length <= 1024);
            Assert.True(p.PropertyPath.Length <= 512);
        });
    }

    [Fact]
    public void OrdinaryProperties_RemainScalarAndUnchanged()
    {
        var component = DescribeRoot();
        var ordinary = Prop(component, nameof(ExpandableMetadataComponent.OrdinaryText));

        Assert.Equal("System.String", ordinary.Type);
        Assert.Equal("plain", ordinary.Value);
        Assert.False(ordinary.ReadOnly);
        Assert.Null(ordinary.StandardValues);
        Assert.False(ordinary.StandardValuesExclusive);
        Assert.Null(ordinary.Properties);
        Assert.False(ordinary.PropertiesTruncated);
    }

    [Fact]
    public void V2_FND_001_S043_SlowStandardValuesConverter_TimesOutWithoutDropdown()
    {
        SlowStandardValuesConverter.ResetProbe();
        var component = Describe(new SlowStandardValuesComponent(), nameof(SlowStandardValuesComponent));
        var mode = Prop(component, nameof(SlowStandardValuesComponent.Mode));

        Assert.Equal("Alpha", mode.Value);
        Assert.Null(mode.StandardValues);
        Assert.False(mode.StandardValuesExclusive);
        Assert.Equal("CONVERTER_TIMEOUT", mode.MetadataDiagnosticCode);
        Assert.Null(mode.Properties);
        Assert.True(SlowStandardValuesConverter.WaitForProbe(), "the abandoned converter probe should finish during the test");

        var healthy = Describe(new ExpandableMetadataComponent(), nameof(ExpandableMetadataComponent));
        var healthyMode = Child(Prop(healthy, nameof(ExpandableMetadataComponent.Expandable)).Properties!, "Nested");
        Assert.Equal(new[] { "Alpha", "Beta" }, Child(healthyMode.Properties!, "Mode").StandardValues);
    }

    // The test above passes on an idle machine whatever the guard does. Its net48 twin failed on a CI runner because
    // the guard ran converter queries on the THREAD POOL: a stalled converter parks its thread for good, .NET injects
    // replacements slowly, and the next query then spent its whole budget queued — so the property lost its VALUE,
    // not just its dropdown. Pin the property that made that possible, since a fast machine cannot observe it.
    [Fact]
    public void ConverterQueries_NeverRunOnAThreadPoolThread()
    {
        ThreadAffinityConverter.RanOnPoolThread = null;
        Describe(new ThreadAffinityComponent(), nameof(ThreadAffinityComponent));

        Assert.False(ThreadAffinityConverter.RanOnPoolThread,
            "a converter query running on a pool thread makes a busy machine drop property values");
    }

    private static ComponentInfo DescribeRoot()
    {
        return Describe(new ExpandableMetadataComponent(), nameof(ExpandableMetadataComponent));
    }

    private static ComponentInfo Describe(IComponent root, string rootName)
    {
        using var container = new Container();
        container.Add(root, "root");
        var host = new TestDesignerHost(container, root);
        var component = DesignerDescribe.DescribeComponent(host, rootName, new HashSet<(IComponent, string)>(), "this");
        Assert.NotNull(component);
        return component!;
    }

    private static WinFormsDesigner.Engine.PropertyInfo Prop(ComponentInfo component, string name) =>
        Assert.Single(component.Properties, p => p.Name == name);

    private static ExpandablePropertyInfo Child(IEnumerable<ExpandablePropertyInfo> properties, string name) =>
        Assert.Single(properties, p => p.Name == name);
}

public sealed class ExpandableMetadataComponent : Component
{
    [TypeConverter(typeof(ContextRequiredExpandableConverter))]
    public ExpandableMetadataObject Expandable { get; } = new();

    [TypeConverter(typeof(ThrowingExpandableConverter))]
    public ThrowingExpandableObject Throwing { get; } = new();

    [TypeConverter(typeof(CycleNodeConverter))]
    public CycleNode Cycle { get; } = new();

    [TypeConverter(typeof(ManyPropertiesConverter))]
    public ManyPropertiesObject Many { get; } = new();

    [DefaultValue("plain")]
    public string OrdinaryText { get; set; } = "plain";
}

public sealed class SlowStandardValuesComponent : Component
{
    [DefaultValue("Alpha")]
    [TypeConverter(typeof(SlowStandardValuesConverter))]
    public string Mode { get; set; } = "Alpha";
}

public sealed class ThreadAffinityComponent : Component
{
    [DefaultValue("Alpha")]
    [TypeConverter(typeof(ThreadAffinityConverter))]
    public string Mode { get; set; } = "Alpha";
}

public sealed class ThreadAffinityConverter : StringConverter
{
    // null until the converter is asked anything — Assert.False then fails, which is the honest outcome.
    internal static bool? RanOnPoolThread;

    public override bool GetStandardValuesSupported(ITypeDescriptorContext? context)
    {
        RanOnPoolThread = System.Threading.Thread.CurrentThread.IsThreadPoolThread;
        return false;
    }
}

internal sealed class TestDesignerHost : IDesignerHost
{
    private readonly IServiceContainer _services = new ServiceContainer();

    public TestDesignerHost(IContainer container, IComponent root)
    {
        Container = container;
        RootComponent = root;
        _services.AddService(typeof(IDesignerHost), this);
        _services.AddService(typeof(IContainer), container);
    }

    public IContainer Container { get; }
    public bool InTransaction => false;
    public bool Loading => false;
    public IComponent RootComponent { get; }
    public string RootComponentClassName => RootComponent.GetType().FullName ?? RootComponent.GetType().Name;
    public string TransactionDescription => "";

    public event EventHandler? Activated { add { } remove { } }
    public event EventHandler? Deactivated { add { } remove { } }
    public event EventHandler? LoadComplete { add { } remove { } }
    public event DesignerTransactionCloseEventHandler? TransactionClosed { add { } remove { } }
    public event DesignerTransactionCloseEventHandler? TransactionClosing { add { } remove { } }
    public event EventHandler? TransactionOpened { add { } remove { } }
    public event EventHandler? TransactionOpening { add { } remove { } }

    public void Activate() { }

    public IComponent CreateComponent(Type componentClass) => CreateComponent(componentClass, null);

    public IComponent CreateComponent(Type componentClass, string? name)
    {
        var component = (IComponent)Activator.CreateInstance(componentClass)!;
        Container.Add(component, name);
        return component;
    }

    public DesignerTransaction CreateTransaction() => new NoopDesignerTransaction("");

    public DesignerTransaction CreateTransaction(string description) => new NoopDesignerTransaction(description);

    public void DestroyComponent(IComponent component) => Container.Remove(component);

    public IDesigner? GetDesigner(IComponent component) => null;

    public Type? GetType(string typeName) => Type.GetType(typeName);

    public object? GetService(Type serviceType) => _services.GetService(serviceType);

    public void AddService(Type serviceType, ServiceCreatorCallback callback) => _services.AddService(serviceType, callback);

    public void AddService(Type serviceType, ServiceCreatorCallback callback, bool promote) => _services.AddService(serviceType, callback, promote);

    public void AddService(Type serviceType, object serviceInstance) => _services.AddService(serviceType, serviceInstance);

    public void AddService(Type serviceType, object serviceInstance, bool promote) => _services.AddService(serviceType, serviceInstance, promote);

    public void RemoveService(Type serviceType) => _services.RemoveService(serviceType);

    public void RemoveService(Type serviceType, bool promote) => _services.RemoveService(serviceType, promote);

    private sealed class NoopDesignerTransaction : DesignerTransaction
    {
        public NoopDesignerTransaction(string description) : base(description) { }
        protected override void OnCancel() { }
        protected override void OnCommit() { }
    }
}

public sealed class ExpandableMetadataObject
{
    [Category("Nested")]
    [Description("Caption text")]
    public string Caption { get; set; } = "hello";

    [ReadOnly(true)]
    public int Locked { get; set; } = 7;

    public Point Location { get; set; } = new(3, 4);

    [TypeConverter(typeof(ContextRequiredExpandableConverter))]
    public NestedMetadataObject Nested { get; } = new();
}

public sealed class NestedMetadataObject
{
    [Category("Choice")]
    [Description("Mode choice")]
    [TypeConverter(typeof(StandardChoiceConverter))]
    public string Mode { get; set; } = "Alpha";

    public Size Size { get; set; } = new(5, 6);
}

public sealed class ThrowingExpandableObject
{
    public override string ToString() => nameof(ThrowingExpandableObject);
}

[TypeConverter(typeof(CycleNodeConverter))]
public sealed class CycleNode
{
    public CycleNode Self => this;
    public Point Point { get; set; } = new(1, 2);
}

public sealed class ManyPropertiesObject
{
}

public sealed class ContextRequiredExpandableConverter : TypeConverter
{
    public override bool CanConvertTo(ITypeDescriptorContext? context, Type? destinationType) =>
        destinationType == typeof(string) || base.CanConvertTo(context, destinationType);

    public override object? ConvertTo(ITypeDescriptorContext? context, System.Globalization.CultureInfo? culture, object? value, Type destinationType) =>
        destinationType == typeof(string) ? value?.GetType().Name : base.ConvertTo(context, culture, value, destinationType);

    public override bool GetPropertiesSupported(ITypeDescriptorContext? context) =>
        context?.PropertyDescriptor != null;

    public override PropertyDescriptorCollection GetProperties(ITypeDescriptorContext? context, object value, Attribute[]? attributes) =>
        context?.PropertyDescriptor == null
            ? new PropertyDescriptorCollection(Array.Empty<PropertyDescriptor>())
            : TypeDescriptor.GetProperties(value, attributes ?? Array.Empty<Attribute>(), true);
}

public sealed class StandardChoiceConverter : StringConverter
{
    private static readonly StandardValuesCollection Values = new(new[] { "Alpha", "Beta" });

    public override bool GetStandardValuesSupported(ITypeDescriptorContext? context) => true;
    public override bool GetStandardValuesExclusive(ITypeDescriptorContext? context) => true;
    public override StandardValuesCollection GetStandardValues(ITypeDescriptorContext? context) => Values;
}

public sealed class SlowStandardValuesConverter : StringConverter
{
    private static readonly System.Threading.ManualResetEventSlim ProbeFinished = new(initialState: true);

    public static void ResetProbe() => ProbeFinished.Reset();

    public static bool WaitForProbe() => ProbeFinished.Wait(TimeSpan.FromSeconds(2));

    public override bool GetStandardValuesSupported(ITypeDescriptorContext? context)
    {
        try
        {
            System.Threading.Thread.Sleep(TimeSpan.FromMilliseconds(300));
            return true;
        }
        finally
        {
            ProbeFinished.Set();
        }
    }

    public override StandardValuesCollection GetStandardValues(ITypeDescriptorContext? context) =>
        new(new[] { "Alpha", "Beta" });
}

public sealed class ThrowingExpandableConverter : TypeConverter
{
    public override bool CanConvertTo(ITypeDescriptorContext? context, Type? destinationType) =>
        destinationType == typeof(string) || base.CanConvertTo(context, destinationType);

    public override object? ConvertTo(ITypeDescriptorContext? context, System.Globalization.CultureInfo? culture, object? value, Type destinationType) =>
        destinationType == typeof(string) ? value?.ToString() : base.ConvertTo(context, culture, value, destinationType);

    public override bool GetPropertiesSupported(ITypeDescriptorContext? context) =>
        throw new InvalidOperationException("hostile converter");

    public override PropertyDescriptorCollection GetProperties(ITypeDescriptorContext? context, object value, Attribute[]? attributes) =>
        throw new InvalidOperationException("hostile converter");
}

public sealed class CycleNodeConverter : TypeConverter
{
    public override bool CanConvertTo(ITypeDescriptorContext? context, Type? destinationType) =>
        destinationType == typeof(string) || base.CanConvertTo(context, destinationType);

    public override object? ConvertTo(ITypeDescriptorContext? context, System.Globalization.CultureInfo? culture, object? value, Type destinationType) =>
        destinationType == typeof(string) ? nameof(CycleNode) : base.ConvertTo(context, culture, value, destinationType);

    public override bool GetPropertiesSupported(ITypeDescriptorContext? context) => true;

    public override PropertyDescriptorCollection GetProperties(ITypeDescriptorContext? context, object value, Attribute[]? attributes) =>
        TypeDescriptor.GetProperties(value, attributes ?? Array.Empty<Attribute>(), true);
}

public sealed class ManyPropertiesConverter : TypeConverter
{
    public override bool CanConvertTo(ITypeDescriptorContext? context, Type? destinationType) =>
        destinationType == typeof(string) || base.CanConvertTo(context, destinationType);

    public override object? ConvertTo(ITypeDescriptorContext? context, System.Globalization.CultureInfo? culture, object? value, Type destinationType) =>
        destinationType == typeof(string) ? nameof(ManyPropertiesObject) : base.ConvertTo(context, culture, value, destinationType);

    public override bool GetPropertiesSupported(ITypeDescriptorContext? context) => true;

    public override PropertyDescriptorCollection GetProperties(ITypeDescriptorContext? context, object value, Attribute[]? attributes) =>
        new(Enumerable.Range(0, 200).Select(i => new ManyPropertyDescriptor(i)).ToArray());
}

internal sealed class ManyPropertyDescriptor : PropertyDescriptor
{
    private readonly int _index;

    public ManyPropertyDescriptor(int index)
        : base("Item" + index.ToString("000"), new Attribute[]
        {
            new CategoryAttribute("Bounds"),
            new DescriptionAttribute(new string('d', 1500)),
        })
    {
        _index = index;
    }

    public override Type ComponentType => typeof(ManyPropertiesObject);
    public override bool IsReadOnly => false;
    public override Type PropertyType => typeof(string);
    public override bool CanResetValue(object component) => false;
    public override object GetValue(object? component) => "value-" + _index + "-" + new string('x', 2000);
    public override void ResetValue(object component) { }
    public override void SetValue(object? component, object? value) { }
    public override bool ShouldSerializeValue(object component) => false;
}
