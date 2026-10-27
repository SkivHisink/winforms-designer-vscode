using System;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.Windows.Forms;
using Microsoft.DotNet.DesignTools.Designers;
using Microsoft.DotNet.DesignTools.Designers.Actions;

namespace Independent.ModernDesigner;

[Designer(typeof(ProbeDesigner))]
public sealed class ProbeControl : Control { }

// This is an actual SDK-derived designer, independent of the extension and its preview SDK.
public sealed class ProbeDesigner : ControlDesigner
{
    public override DesignerActionListCollection ActionLists =>
        new DesignerActionListCollection { new ProbeActions(Component) };
}

public sealed class ProbeActions : DesignerActionList
{
    public ProbeActions(IComponent component) : base(component) { }

    public override DesignerActionItemCollection GetSortedActionItems() =>
        new DesignerActionItemCollection
        {
            new DesignerActionMethodItem(this, nameof(SetCaption), "Set caption", "Probe", "Public SDK ABI probe", true)
        };

    public void SetCaption()
    {
        var component = Component ?? throw new InvalidOperationException("An initialized component is required.");
        var host = GetService(typeof(IDesignerHost)) as IDesignerHost
            ?? throw new InvalidOperationException("IDesignerHost is required.");
        var change = GetService(typeof(IComponentChangeService)) as IComponentChangeService
            ?? throw new InvalidOperationException("IComponentChangeService is required.");
        var property = TypeDescriptor.GetProperties(component)["Text"]
            ?? throw new InvalidOperationException("The Text property is required.");
        using var transaction = host.CreateTransaction("ABI probe caption");
        var before = property.GetValue(component);
        change.OnComponentChanging(component, property);
        property.SetValue(component, "SDK ABI probe");
        change.OnComponentChanged(component, property, before, "SDK ABI probe");
        transaction.Commit();
    }
}

// The official modern collection editor is a server-side contract, not classic UITypeEditor.
public sealed class ProbeCollectionEditor : Microsoft.DotNet.DesignTools.Editors.CollectionEditor
{
    public ProbeCollectionEditor(IServiceProvider services, Type type) : base(services, type) { }
}
