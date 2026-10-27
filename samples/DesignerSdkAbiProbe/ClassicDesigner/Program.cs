using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.Drawing.Design;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace Independent.ClassicDesigner
{
    [Designer(typeof(ProbeDesigner))]
    public sealed class ProbeControl : Control
    {
        [Editor(typeof(ProbeEditor), typeof(UITypeEditor))]
        public string ProbeValue { get; set; } = "unchanged";
    }

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
                new DesignerActionMethodItem(this, nameof(SetCaption), "Set caption", "Probe", "Public classic ABI probe", true)
            };
        public void SetCaption()
        {
            var host = GetService(typeof(IDesignerHost)) as IDesignerHost
                ?? throw new InvalidOperationException("IDesignerHost is required.");
            var change = GetService(typeof(IComponentChangeService)) as IComponentChangeService
                ?? throw new InvalidOperationException("IComponentChangeService is required.");
            var property = TypeDescriptor.GetProperties(Component)["Text"];
            using (var transaction = host.CreateTransaction("ABI probe caption"))
            {
                var before = property.GetValue(Component);
                change.OnComponentChanging(Component, property);
                property.SetValue(Component, "Classic ABI probe");
                change.OnComponentChanged(Component, property, before, "Classic ABI probe");
                transaction.Commit();
            }
        }
    }

    public sealed class ProbeEditor : UITypeEditor
    {
        public string LastRefusal { get; private set; }
        public override UITypeEditorEditStyle GetEditStyle(ITypeDescriptorContext context) => UITypeEditorEditStyle.DropDown;
        public override object EditValue(ITypeDescriptorContext context, IServiceProvider provider, object value)
        {
            var service = provider?.GetService(typeof(IWindowsFormsEditorService)) as IWindowsFormsEditorService;
            if (service == null)
            {
                LastRefusal = "NATIVE_EDITOR_SERVICE_UNAVAILABLE";
                return value;
            }
            using (var choices = new ListBox())
            {
                choices.Items.Add("proposed");
                try { service.DropDownControl(choices); }
                catch (HeadlessUiRefusedException)
                {
                    LastRefusal = "NATIVE_UI_NOT_EXECUTED";
                    return value;
                }
            }
            throw new InvalidOperationException("The headless UI boundary did not refuse the request.");
        }
    }

    public sealed class HeadlessUiRefusedException : Exception { }

    // A refusal boundary, never advertised as an implementation of interactive native UI.
    internal sealed class HeadlessEditorBoundary : IWindowsFormsEditorService, IServiceProvider
    {
        public int DropDownRequests { get; private set; }
        public object GetService(Type type) => type == typeof(IWindowsFormsEditorService) ? this : null;
        public void DropDownControl(Control control)
        {
            DropDownRequests++;
            throw new HeadlessUiRefusedException();
        }
        public void CloseDropDown() => throw new HeadlessUiRefusedException();
        public DialogResult ShowDialog(Form dialog) => throw new HeadlessUiRefusedException();
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args.Length != 1) throw new ArgumentException("Supply the report file path.");
            using (var surface = new DesignSurface(typeof(Form)))
            {
                var host = surface.GetService(typeof(IDesignerHost)) as IDesignerHost
                    ?? throw new InvalidOperationException("The real DesignSurface did not provide IDesignerHost.");
                var change = surface.GetService(typeof(IComponentChangeService)) as IComponentChangeService
                    ?? throw new InvalidOperationException("The real DesignSurface did not provide change notifications.");
                var selection = surface.GetService(typeof(ISelectionService)) as ISelectionService
                    ?? throw new InvalidOperationException("The real DesignSurface did not provide selection.");
                int changing = 0, changed = 0, committed = 0;
                change.ComponentChanging += (sender, e) => changing++;
                change.ComponentChanged += (sender, e) => changed++;
                host.TransactionClosed += (sender, e) => { if (e.TransactionCommitted) committed++; };
                var control = (ProbeControl)host.CreateComponent(typeof(ProbeControl), "probe");
                var designer = host.GetDesigner(control) as ProbeDesigner
                    ?? throw new InvalidOperationException("The real DesignSurface did not activate the custom designer.");
                selection.SetSelectedComponents(new object[] { control });
                var actions = (ProbeActions)designer.ActionLists[0];
                if (actions.GetSortedActionItems().Count != 1) throw new InvalidOperationException("The action was not discoverable.");
                actions.SetCaption();
                if (control.Text != "Classic ABI probe" || changing == 0 || changed == 0 || committed == 0)
                    throw new InvalidOperationException("Real service invocation did not produce all postconditions.");
                var property = TypeDescriptor.GetProperties(control)[nameof(ProbeControl.ProbeValue)];
                var editor = property.GetEditor(typeof(UITypeEditor)) as ProbeEditor
                    ?? throw new InvalidOperationException("The editor attribute did not activate the custom UITypeEditor.");
                var boundary = new HeadlessEditorBoundary();
                var result = editor.EditValue(null, boundary, control.ProbeValue);
                if (!Equals(result, "unchanged") || editor.LastRefusal != "NATIVE_UI_NOT_EXECUTED" || boundary.DropDownRequests != 1)
                    throw new InvalidOperationException("The native UI boundary did not preserve the old value.");
                var services = new Dictionary<string, string>();
                foreach (var type in new[] { typeof(IDesignerHost), typeof(IComponentChangeService), typeof(ISelectionService), typeof(IMenuCommandService), typeof(ITypeResolutionService), typeof(System.ComponentModel.Design.Serialization.IDesignerSerializationService) })
                    services.Add(type.AssemblyQualifiedName, surface.GetService(type)?.GetType().AssemblyQualifiedName ?? "UNAVAILABLE");
                var report = new
                {
                    schemaVersion = 1, status = "PASS", contract = "classic-System.Design", runtime = Environment.Version.ToString(),
                    apartment = Thread.CurrentThread.GetApartmentState().ToString(),
                    designerBase = typeof(ControlDesigner).AssemblyQualifiedName,
                    actionListBase = typeof(DesignerActionList).AssemblyQualifiedName,
                    editorBase = typeof(UITypeEditor).AssemblyQualifiedName,
                    editorService = typeof(IWindowsFormsEditorService).AssemblyQualifiedName,
                    designerActivatedByRealHost = true, selected = ReferenceEquals(selection.PrimarySelection, control),
                    actionCaption = control.Text, changing, changed, committed,
                    editorStyle = editor.GetEditStyle(null).ToString(), editorRefusal = editor.LastRefusal,
                    nativeDropDownRequests = boundary.DropDownRequests, nativeWindowsDisplayed = 0, services,
                    nativeUiAcceptance = "NOT_EXECUTED: public service request refused headlessly; ownership/focus/Escape remain separate product gates."
                };
                File.WriteAllText(args[0], new JavaScriptSerializer().Serialize(report));
            }
            Console.WriteLine("Classic DesignSurface, designer action and editor refusal: PASS");
            return 0;
        }
    }
}
