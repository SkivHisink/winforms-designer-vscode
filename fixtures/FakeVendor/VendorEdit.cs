using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Design;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace FakeVendor
{
    // Mimics the DevExpress XtraEditors shape the interpreter must handle: an editor whose settings live in a
    // SUB-OBJECT (DevExpress calls it the RepositoryItem, exposed as `Properties`), and whose designer bracket wraps
    // THAT object rather than the control — ((ISupportInitialize)(this.vendorEdit1.Properties)).BeginInit(). Every
    // XtraEditors control on a real form emits that shape, so a bracket that only accepted a bare field target sent
    // every DevExpress form to the compiled fallback.
    public sealed class VendorEditProperties : ISupportInitialize
    {
        private readonly VendorEdit _owner;

        internal VendorEditProperties(VendorEdit owner) { _owner = owner; }

        /// <summary>True only AFTER a balanced BeginInit/EndInit pair ran on the SUB-OBJECT.</summary>
        public bool IsInitialized { get; private set; }

        [Editor(typeof(VendorCaptionEditor), typeof(UITypeEditor))]
        public string Caption { get; set; } = "";

        public void BeginInit() { }

        public void EndInit()
        {
            IsInitialized = true;
            // The "finalize layout" a real vendor editor performs on EndInit. It is deliberately OBSERVABLE in
            // geometry: if the interpreter ever stops replaying the chained bracket, the interpreted control is 4px
            // shorter than the compiled one and the differential e2e fails instead of silently drifting.
            _owner.Height += 4;
        }
    }

    // Mimics the OTHER vendor shape the interpreter must get right: a control that HIDES a framework layout method
    // with `new` (DevExpress's XtraForm hides SuspendLayout). The compiled form runs the vendor member, so replaying
    // Control's instead would silently diverge — which is why the hider's effect here is visible in GEOMETRY: the
    // differential e2e fails on a 5px offset rather than letting a wrong-member replay pass.
    public class VendorPanel : Panel
    {
        public new void SuspendLayout()
        {
            Left += 5;
            base.SuspendLayout();
        }
    }

    public class VendorEdit : Control
    {
        public VendorEdit()
        {
            Properties = new VendorEditProperties(this);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint, true);
        }

        [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
        public VendorEditProperties Properties { get; }

        [Editor(typeof(VendorComplexValueEditor), typeof(UITypeEditor))]
        public string ComplexValue { get; set; } = "Vendor Alpha";

        [Editor(typeof(VendorInvalidResultEditor), typeof(UITypeEditor))]
        public string InvalidEditorValue { get; set; } = "Vendor Alpha";

        [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
        [Editor(typeof(VendorThresholdsEditor), typeof(UITypeEditor))]
        public IList<int> Thresholds { get; } = new List<int>();

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(SystemColors.Window);
            ControlPaint.DrawBorder(e.Graphics, ClientRectangle, SystemColors.ControlDark, ButtonBorderStyle.Solid);
            TextRenderer.DrawText(e.Graphics, Properties.Caption, Font, ClientRectangle, SystemColors.WindowText,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
        }
    }

    public sealed class VendorCaptionEditor : UITypeEditor
    {
        public override UITypeEditorEditStyle GetEditStyle(ITypeDescriptorContext context) =>
            UITypeEditorEditStyle.Modal;
    }

    public sealed class VendorComplexValueEditor : UITypeEditor
    {
        public const string AutomationEnvironmentVariable = "WFD_FAKE_VENDOR_COMPLEX_VALUE_RESULT";

        public override UITypeEditorEditStyle GetEditStyle(ITypeDescriptorContext context) =>
            UITypeEditorEditStyle.DropDown;

        public override object EditValue(ITypeDescriptorContext context, IServiceProvider provider, object value)
        {
            // Lets the product Extension Host proof exercise the invalid-result boundary after a normal source edit,
            // without opening UI or changing the worker process environment between the two calls.
            if (value as string == "__invalid_object__") return new object();
            string automated = System.Environment.GetEnvironmentVariable(AutomationEnvironmentVariable);
            if (automated == "__invalid_object__") return new object();
            if (!string.IsNullOrEmpty(automated)) return automated;

            IWindowsFormsEditorService service =
                (IWindowsFormsEditorService)provider?.GetService(typeof(IWindowsFormsEditorService));
            if (service == null) return value;

            using (var list = new ListBox())
            {
                list.IntegralHeight = true;
                list.Items.Add("Vendor Alpha");
                list.Items.Add("Vendor Beta");
                list.Items.Add("Vendor Gamma");
                list.SelectedItem = value as string ?? "Vendor Alpha";
                list.Click += (_, __) => service.CloseDropDown();
                service.DropDownControl(list);
                return list.SelectedItem as string ?? value;
            }
        }
    }

    public sealed class VendorInvalidResultEditor : UITypeEditor
    {
        public override UITypeEditorEditStyle GetEditStyle(ITypeDescriptorContext context) =>
            UITypeEditorEditStyle.DropDown;

        public override object EditValue(ITypeDescriptorContext context, IServiceProvider provider, object value) =>
            new object();
    }

    public sealed class VendorThresholdsEditor : UITypeEditor
    {
        public const string AutomationEnvironmentVariable = "WFD_FAKE_VENDOR_THRESHOLDS_RESULT";

        public override UITypeEditorEditStyle GetEditStyle(ITypeDescriptorContext context) =>
            UITypeEditorEditStyle.Modal;

        public override object EditValue(ITypeDescriptorContext context, IServiceProvider provider, object value)
        {
            string automated = Environment.GetEnvironmentVariable(AutomationEnvironmentVariable);
            if (!string.IsNullOrWhiteSpace(automated))
            {
                var parsed = Parse(automated);
                return parsed ?? value;
            }

            var current = value as IEnumerable<int> ?? Array.Empty<int>();
            IWindowsFormsEditorService service =
                (IWindowsFormsEditorService)provider?.GetService(typeof(IWindowsFormsEditorService));
            if (service == null) return value;

            using (var dialog = new Form())
            using (var values = new TextBox())
            using (var accept = new Button())
            using (var cancel = new Button())
            {
                dialog.Text = "Edit thresholds";
                dialog.FormBorderStyle = FormBorderStyle.FixedDialog;
                dialog.StartPosition = FormStartPosition.CenterParent;
                dialog.ClientSize = new Size(300, 220);
                dialog.MinimizeBox = false;
                dialog.MaximizeBox = false;
                values.Multiline = true;
                values.ScrollBars = ScrollBars.Vertical;
                values.Location = new Point(12, 12);
                values.Size = new Size(276, 160);
                values.Text = string.Join(Environment.NewLine, current);
                accept.Text = "OK";
                accept.DialogResult = DialogResult.OK;
                accept.Location = new Point(132, 184);
                cancel.Text = "Cancel";
                cancel.DialogResult = DialogResult.Cancel;
                cancel.Location = new Point(213, 184);
                dialog.Controls.Add(values);
                dialog.Controls.Add(accept);
                dialog.Controls.Add(cancel);
                dialog.AcceptButton = accept;
                dialog.CancelButton = cancel;
                if (service.ShowDialog(dialog) != DialogResult.OK) return value;
                return Parse(values.Text) ?? value;
            }
        }

        private static List<int> Parse(string text)
        {
            var result = new List<int>();
            foreach (string part in (text ?? "").Split(new[] { ',', ';', '\r', '\n' },
                StringSplitOptions.RemoveEmptyEntries))
            {
                if (!int.TryParse(part.Trim(), out int value)) return null;
                result.Add(value);
            }
            return result;
        }
    }
}
