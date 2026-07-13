using System;
using System.Collections.Generic;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// One control's placement in the FULL-FRAME (window) pixel space plus minimal tree info — the unit
    /// of the click-to-select hit-test map (see <see cref="DesignerRenderer.DescribeLayout"/>). Coordinates
    /// share <c>RenderControl</c>'s transform, so a selection rectangle and a dirty-region patch align.
    /// </summary>
    public sealed class LayoutControl
    {
        /// <summary>Edit id for SetProperty/DescribeComponent/RenderControl ("this" = root, else Site.Name).</summary>
        public string Id { get; init; } = "";
        /// <summary>Display name (root class name for the root, Site.Name otherwise).</summary>
        public string Name { get; init; } = "";
        public string Type { get; init; } = "";
        /// <summary>Parent control's edit id, or null for the root.</summary>
        public string? ParentId { get; init; }
        public bool IsRoot { get; init; }
        public int X { get; init; }
        public int Y { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
        /// <summary>Nesting level from the root (root = 0). Higher wins a hit-test (innermost on top).</summary>
        public int Depth { get; init; }
        /// <summary>The control's TabIndex (for the tab-order editor overlay). Root = -1 (no tab order).</summary>
        public int TabIndex { get; init; }
        /// <summary>Anchor edges as an invariant string ("Top, Left" / "None") — feeds the canvas anchor-tether
        /// overlay (Phase 2). Root = "None".</summary>
        public string Anchor { get; init; } = "None";
        /// <summary>Dock style ("Fill"/"Top"/… / "None") — feeds the canvas dock indicator. Root = "None".</summary>
        public string Dock { get; init; } = "None";
        /// <summary>True when this control is a ToolStrip/MenuStrip/StatusStrip — the canvas routes clicks on it into
        /// on-canvas item mode ("Type Here" add / item rename / delete) instead of a plain control select.</summary>
        public bool IsStripHost { get; init; }
    }

    /// <summary>
    /// One TOP-LEVEL ToolStrip/MenuStrip/StatusStrip item's window-space rectangle (or the synthesized trailing
    /// "Type Here" slot) — the read side behind on-canvas item add/rename/delete. Same window-space transform as
    /// <see cref="LayoutControl"/> so a per-item overlay lines up with the rendered strip. Nested/submenu items are
    /// intentionally absent: a closed DropDown isn't laid out, so its children have no meaningful bounds.
    /// </summary>
    public sealed class ToolStripItemBounds
    {
        /// <summary>The owning strip's edit id (Site.Name, or "this" if the strip is the root — never happens).</summary>
        public string OwnerId { get; init; } = "";
        /// <summary>The item's designer field id (Site.Name) — the identity the item editor edits by. Empty for the
        /// trailing "Type Here" slot.</summary>
        public string ItemId { get; init; } = "";
        /// <summary>The item's concrete type FullName (empty for the "Type Here" slot).</summary>
        public string ItemType { get; init; } = "";
        /// <summary>The item's live caption (ToolStripItem.Text) — the canvas prefills the inline rename editor with
        /// it (empty for the "Type Here" slot and for text-less items like a Separator).</summary>
        public string Text { get; init; } = "";
        public int X { get; init; }
        public int Y { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
        /// <summary>True for the synthesized trailing add-slot placed after the last item along the strip orientation.</summary>
        public bool IsTypeHere { get; init; }
        /// <summary>True for the strip's OVERFLOW chevron button (the "&gt;&gt;" the ToolStrip paints at its edge when items
        /// don't fit): a bounds-carrying, id-less item whose <see cref="Children"/> are the overflow-placed items
        /// (Placement==Overflow). The canvas opens a synthetic flyout of those items anchored at this rect. When set, the
        /// strip is full so no trailing "Type Here" slot is emitted.</summary>
        public bool Overflow { get; init; }
        /// <summary>This item's nested DropDownItems (a ToolStripDropDownItem's submenu), recursively — id/text/type only
        /// (no bounds: a closed dropdown isn't laid out, so the canvas draws a SYNTHETIC flyout client-side and routes a
        /// child click through the existing item→Properties channel). Empty for leaf items, separators, and the "Type
        /// Here" slot. OwnerId on each child is the top-level strip (the selectItem host context).</summary>
        public List<ToolStripItemBounds> Children { get; init; } = new();
    }

    /// <summary>One non-visual component for the component tray: Timer, ToolTip, ErrorProvider,
    /// ImageList, BindingSource, ContextMenuStrip, … — anything in the host container that isn't a control
    /// parented into the visual tree. Id is the SetProperty/DescribeComponent edit id (Site.Name).</summary>
    public sealed class TrayComponent
    {
        public string Id { get; init; } = "";
        public string Name { get; init; } = "";
        public string Type { get; init; } = "";
        /// <summary>For an OFF-TREE ToolStrip surfaced in the tray (a ContextMenuStrip / ToolStripDropDown, which is a
        /// sited field but never painted on the surface), its top-level Items as a BOUNDS-LESS forest (id/text/type +
        /// recursive <see cref="ToolStripItemBounds.Children"/>) — the canvas opens a SYNTHETIC flyout from the tray
        /// chip so the strip's items are reachable on the canvas (Properties / rename / delete / add) exactly as a
        /// menu-bar item's DropDownItems are. Empty for a non-strip component (Timer/ImageList/…) and for an empty
        /// strip. Each item's <see cref="ToolStripItemBounds.OwnerId"/> is the strip's id (the host splice key).</summary>
        public List<ToolStripItemBounds> Items { get; init; } = new();
        /// <summary>True when this tray component is a <see cref="ToolStrip"/> (a ContextMenuStrip / off-tree strip) — the
        /// canvas opens its synthetic items flyout on a chip click. Distinguishes an EMPTY strip (still gets a "Type Here"
        /// add-first-item flyout) from a non-strip component (Timer/ImageList/…, whose empty <see cref="Items"/> is
        /// identical). Without this the canvas can't tell them apart, since both serialize an empty Items list.</summary>
        public bool IsStrip { get; init; }
    }

    /// <summary>
    /// Every control's window-space bounds for a designer frame — the read side behind click-to-select.
    /// Controls are ordered innermost-first (deepest, then smallest area) so the host selects the first
    /// rectangle that contains a click.
    /// </summary>
    public sealed class LayoutResult
    {
        public string RootType { get; init; } = "";
        public int Width { get; init; }
        public int Height { get; init; }
        /// <summary>Root's client-area size (the form serializes ClientSize, not the window Size). The host
        /// derives the chrome (= Width-ClientWidth, Height-ClientHeight) to translate a window-corner resize
        /// of the form into a ClientSize edit.</summary>
        public int ClientWidth { get; init; }
        public int ClientHeight { get; init; }
        public List<LayoutControl> Controls { get; init; } = new();
        /// <summary>Non-visual components for the tray.</summary>
        public List<TrayComponent> Tray { get; init; } = new();
        /// <summary>Per-item geometry for every top-level strip item + a trailing "Type Here" slot per strip.</summary>
        public List<ToolStripItemBounds> ToolStripItems { get; init; } = new();
    }

    /// <summary>
    /// A full-frame PNG render PLUS the click-to-select hit-test map, produced from a SINGLE graph load —
    /// the combined complement of <see cref="DesignerRenderer.RenderDetailed"/> + <see cref="DesignerRenderer.DescribeLayout"/>.
    /// The unified designer's full render needs both together; issued as two RPCs each re-parsed,
    /// re-interpreted and rebuilt the graph (the dominant cost on large forms). Folding them into one
    /// halves that work. Png/Width/Height and Controls are byte/field-identical to the two separate calls
    /// (proven headless by e2e byte-equality), so this is a drop-in for renderDesigner + describeLayout.
    /// </summary>
    public sealed class RenderLayoutResult
    {
        /// <summary>The full-frame PNG (same bytes as <see cref="RenderResult.Png"/>).</summary>
        public byte[] Png { get; init; } = Array.Empty<byte>();
        public int Width { get; init; }
        public int Height { get; init; }
        /// <summary>Root client-area size (see <see cref="LayoutResult.ClientWidth"/>).</summary>
        public int ClientWidth { get; init; }
        public int ClientHeight { get; init; }
        public string RootType { get; init; } = "";
        /// <summary>0.10.0 S2: net9 couldn't resolve the form's real base (an inherited/vendor type) → base-contributed
        /// controls are silently dropped from this best-effort preview. The host shows an honest banner. net48 renders
        /// the real compiled type, so it leaves this false.</summary>
        public bool InheritedBase { get; init; }
        /// <summary>Name of the inherited/unresolved base for the banner text; "" when the base resolved.</summary>
        public string BaseTypeName { get; init; } = "";
        /// <summary>0.10.0 S3: count of sibling-.resx resources this net9 preview can't render (BinaryFormatter/SOAP/
        /// ImageStream/FileRef/non-allowlisted value types). Drives an honest banner. net48 renders the real compiled
        /// instance (resources present), so it leaves this 0.</summary>
        public int UnrenderableResxCount { get; init; }
        public int TotalStatements { get; init; }
        public int Representable { get; init; }
        public List<string> Unrepresentable { get; init; } = new();
        /// <summary>Hit-test map, innermost-first (deepest, then smallest area) — same order as <see cref="LayoutResult.Controls"/>.</summary>
        public List<LayoutControl> Controls { get; init; } = new();
        /// <summary>Non-visual components for the tray.</summary>
        public List<TrayComponent> Tray { get; init; } = new();
        /// <summary>Per-item geometry for every top-level strip item + a trailing "Type Here" slot per strip.</summary>
        public List<ToolStripItemBounds> ToolStripItems { get; init; } = new();
    }
}
