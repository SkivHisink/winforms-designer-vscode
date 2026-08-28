using System;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Drawing;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace FakeVendor
{
    /// <summary>Repository-owned fixture for the bounded hosted-service product contract. It is intentionally small,
    /// but its designer uses the same IDesignerHost/DesignerTransaction/IComponentChangeService sequence as a real
    /// vendor smart-tag command that changes more than one persisted property.</summary>
    [Designer(typeof(HostedServiceControlDesigner))]
    public sealed class HostedServiceControl : Control
    {
    }

    public sealed class HostedServiceControlDesigner : ControlDesigner
    {
        private DesignerActionListCollection _actionLists;

        public bool CompleteHostObserved { get; private set; }
        public bool UnsupportedServiceObserved { get; private set; }

        public override void Initialize(IComponent component)
        {
            base.Initialize(component);
            var site = component.Site;
            CompleteHostObserved = site?.GetService(typeof(IDesignerHost)) is IDesignerHost
                && site.GetService(typeof(IComponentChangeService)) is IComponentChangeService
                && site.GetService(typeof(ISelectionService)) is ISelectionService
                && site.GetService(typeof(INameCreationService)) is INameCreationService
                && site.GetService(typeof(IMenuCommandService)) is IMenuCommandService;
            UnsupportedServiceObserved = site?.GetService(typeof(IDesignerSerializationService)) == null;
        }

        public override DesignerActionListCollection ActionLists =>
            _actionLists ??= new DesignerActionListCollection
            {
                new HostedServiceControlActionList((HostedServiceControl)Component),
            };
    }

    public sealed class HostedServiceControlActionList : DesignerActionList
    {
        public const string CommandId = "applyServicePreset";
        public const string ReentrantCommandId = "cancelReentrantServiceAction";
        public const string CertificationId = "repo.fakevendor.hosted-service-kernel.v1";

        private readonly HostedServiceControl _control;

        public HostedServiceControlActionList(HostedServiceControl control)
            : base(control)
        {
            _control = control;
        }

        public void ApplyServicePreset()
        {
            var host = _control.Site?.GetService(typeof(IDesignerHost)) as IDesignerHost
                ?? throw new InvalidOperationException("IDesignerHost is unavailable.");
            var changes = _control.Site?.GetService(typeof(IComponentChangeService)) as IComponentChangeService
                ?? throw new InvalidOperationException("IComponentChangeService is unavailable.");
            var text = TypeDescriptor.GetProperties(_control)[nameof(Control.Text)]
                ?? throw new InvalidOperationException("Text metadata is unavailable.");
            var size = TypeDescriptor.GetProperties(_control)[nameof(Control.Size)]
                ?? throw new InvalidOperationException("Size metadata is unavailable.");
            string oldText = _control.Text;
            Size oldSize = _control.Size;

            using DesignerTransaction transaction = host.CreateTransaction("FakeVendor.ApplyServicePreset");
            changes.OnComponentChanging(_control, text);
            _control.Text = "Hosted service preset";
            changes.OnComponentChanged(_control, text, oldText, _control.Text);
            changes.OnComponentChanging(_control, size);
            _control.Size = new Size(180, 42);
            changes.OnComponentChanged(_control, size, oldSize, _control.Size);
            transaction.Commit();
        }

        public void CancelReentrantServiceAction()
        {
            var host = _control.Site?.GetService(typeof(IDesignerHost)) as IDesignerHost
                ?? throw new InvalidOperationException("IDesignerHost is unavailable.");
            var changes = _control.Site?.GetService(typeof(IComponentChangeService)) as IComponentChangeService
                ?? throw new InvalidOperationException("IComponentChangeService is unavailable.");
            var text = TypeDescriptor.GetProperties(_control)[nameof(Control.Text)]
                ?? throw new InvalidOperationException("Text metadata is unavailable.");
            string oldText = _control.Text;

            using DesignerTransaction outer = host.CreateTransaction("FakeVendor.CancelReentrantServiceAction");
            changes.OnComponentChanging(_control, text);
            _control.Text = "Transient reentrant value";
            changes.OnComponentChanged(_control, text, oldText, _control.Text);
            try
            {
                using DesignerTransaction nested = host.CreateTransaction("FakeVendor.NestedTransaction");
                nested.Commit();
                throw new InvalidOperationException("The hosted kernel unexpectedly accepted a nested transaction.");
            }
            catch (NotSupportedException)
            {
                changes.OnComponentChanging(_control, text);
                _control.Text = oldText;
                changes.OnComponentChanged(_control, text, "Transient reentrant value", oldText);
                outer.Cancel();
            }
        }

        public override DesignerActionItemCollection GetSortedActionItems() =>
            new DesignerActionItemCollection
            {
                new DesignerActionMethodItem(
                    this,
                    nameof(ApplyServicePreset),
                    "Apply Service Preset",
                    "FakeVendor",
                    "Changes Text and Size through one hosted DesignerTransaction.",
                    includeAsDesignerVerb: true),
                new DesignerActionMethodItem(
                    this,
                    nameof(CancelReentrantServiceAction),
                    "Cancel Reentrant Service Action",
                    "FakeVendor",
                    "Proves that a nested hosted transaction cancels without a source proposal.",
                    includeAsDesignerVerb: true),
            };

        public string GetHostedDesignerCommandId(string memberName) =>
            string.Equals(memberName, nameof(ApplyServicePreset), StringComparison.Ordinal) ? CommandId
                : string.Equals(memberName, nameof(CancelReentrantServiceAction), StringComparison.Ordinal)
                    ? ReentrantCommandId
                    : "";

        public string GetHostedDesignerCommandCertificationId(string memberName) =>
            string.Equals(memberName, nameof(ApplyServicePreset), StringComparison.Ordinal)
                || string.Equals(memberName, nameof(CancelReentrantServiceAction), StringComparison.Ordinal)
                    ? CertificationId
                    : "";
    }
}
