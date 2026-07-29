using System.ComponentModel;
using System.Drawing;
using System.Windows.Forms;

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

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(SystemColors.Window);
            ControlPaint.DrawBorder(e.Graphics, ClientRectangle, SystemColors.ControlDark, ButtonBorderStyle.Solid);
            TextRenderer.DrawText(e.Graphics, Properties.Caption, Font, ClientRectangle, SystemColors.WindowText,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter);
        }
    }
}
