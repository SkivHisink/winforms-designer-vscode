using System;
using System.Collections.Generic;
using System.ComponentModel;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

public sealed class DesignerDailyLoopMetadataTests
{
    [Fact]
    public void FieldBackedComponent_ExposesEditableDesignNameAndRealDefaultEvent()
    {
        using var container = new Container();
        var root = new Component();
        var child = new DailyLoopMetadataComponent();
        container.Add(root, "root");
        container.Add(child, "button1");
        var host = new TestDesignerHost(container, root);
        var fieldModifiers = new Dictionary<string, DesignerModifiers.FieldMod>(StringComparer.Ordinal)
        {
            // `(Name)` remains independently editable even when the shared Modifiers declaration is not.
            ["button1"] = new DesignerModifiers.FieldMod { Display = "Private", Editable = false },
        };

        var component = DesignerDescribe.DescribeComponent(
            host,
            "DailyLoopForm",
            new HashSet<(IComponent, string)>(),
            "button1",
            fieldModifiers: fieldModifiers);

        Assert.NotNull(component);
        Assert.Equal(nameof(DailyLoopMetadataComponent.Activated), component!.DefaultEvent);
        Assert.Contains(component.Events, e => e.Name == nameof(DailyLoopMetadataComponent.Activated));

        var designName = Assert.Single(component.Properties, p => p.Name == "(Name)");
        Assert.Equal("button1", designName.Value);
        Assert.Equal("System.String", designName.Type);
        Assert.Equal("Design", designName.Category);
        Assert.True(designName.DesignTime);
        Assert.False(designName.ReadOnly);
    }

    [Fact]
    public void Root_DoesNotExposeDesignName()
    {
        using var container = new Container();
        var root = new DailyLoopMetadataComponent();
        container.Add(root, "root");
        var host = new TestDesignerHost(container, root);

        var component = DesignerDescribe.DescribeComponent(
            host,
            "DailyLoopForm",
            new HashSet<(IComponent, string)>(),
            "this");

        Assert.NotNull(component);
        Assert.DoesNotContain(component!.Properties, p => p.Name == "(Name)");
        Assert.Equal(nameof(DailyLoopMetadataComponent.Activated), component.DefaultEvent);
    }
}

[DefaultEvent(nameof(Activated))]
public sealed class DailyLoopMetadataComponent : Component
{
    public event EventHandler? Activated;

    public void RaiseActivated() => Activated?.Invoke(this, EventArgs.Empty);
}
