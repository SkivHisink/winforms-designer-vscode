using System;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.Drawing;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace FakeVendor
{
    // Mimics a DevExpress-style control with an "Appearance" SUB-OBJECT: a settable value graph the designer writes
    // via a property CHAIN (this.fancyButton1.Appearance.BorderColor = ...). The interpreter must walk the chain
    // through TypeDescriptor: read Appearance (non-null, initialized in the ctor), then set BorderColor on it.
    public sealed class FakeAppearance
    {
        public Color BorderColor { get; set; } = Color.Empty;
        public int BorderWidth { get; set; } = 1;
    }

    [Designer(typeof(FancyButtonDesigner))]
    public class FancyButton : Button
    {
        public FancyButton() { Appearance = new FakeAppearance(); }

        // A public, non-null sub-object property — the property-chain target. Not serialized as a value; the designer
        // sets its members individually (exactly the DevExpress Appearance/Options pattern).
        [DesignerSerializationVisibility(DesignerSerializationVisibility.Content)]
        public FakeAppearance Appearance { get; }
    }

    public sealed class FancyButtonDesigner : ControlDesigner
    {
        private DesignerActionListCollection _actionLists;

        public override DesignerActionListCollection ActionLists =>
            _actionLists ??= new DesignerActionListCollection
            {
                new FancyButtonActionList((FancyButton)Component),
            };

        public HostedDesignerAdorner[] GetHostedDesignerAdorners()
        {
            var button = (FancyButton)Component;
            return new[]
            {
                new HostedDesignerAdorner(
                    "fakevendor.caption",
                    "Caption adorner",
                    new Rectangle(0, 0, Math.Min(96, Math.Max(1, button.Width)), 18),
                    hitTestable: true),
            };
        }

        public bool HitTestHostedDesignerAdorner(string id, Point point) =>
            string.Equals(id, "fakevendor.caption", StringComparison.Ordinal)
            && GetHostedDesignerAdorners()[0].Bounds.Contains(point);
    }

    public sealed class HostedDesignerAdorner
    {
        public HostedDesignerAdorner(string id, string displayName, Rectangle bounds, bool hitTestable)
        {
            Id = id;
            DisplayName = displayName;
            Bounds = bounds;
            HitTestable = hitTestable;
        }

        public string Id { get; }
        public string DisplayName { get; }
        public Rectangle Bounds { get; }
        public bool HitTestable { get; }
    }

    public sealed class FancyButtonActionList : DesignerActionList
    {
        private readonly FancyButton _button;

        public FancyButtonActionList(FancyButton button)
            : base(button)
        {
            _button = button;
        }

        public string Caption
        {
            get => _button.Text;
            set => _button.Text = value;
        }

        public override DesignerActionItemCollection GetSortedActionItems()
        {
            var items = new DesignerActionItemCollection
            {
                new DesignerActionPropertyItem(
                    nameof(Caption),
                    "Caption",
                    "FakeVendor",
                    "Edits the vendor button text through the hosted action-list path."),
            };
            return items;
        }

        public string GetHostedDesignerPropertyTarget(string memberName) =>
            string.Equals(memberName, nameof(Caption), StringComparison.Ordinal)
                ? nameof(FancyButton.Text)
                : "";
    }
}
