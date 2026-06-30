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
    }

    /// <summary>One non-visual component for the component tray (§7.3): Timer, ToolTip, ErrorProvider,
    /// ImageList, BindingSource, ContextMenuStrip, … — anything in the host container that isn't a control
    /// parented into the visual tree. Id is the SetProperty/DescribeComponent edit id (Site.Name).</summary>
    public sealed class TrayComponent
    {
        public string Id { get; init; } = "";
        public string Name { get; init; } = "";
        public string Type { get; init; } = "";
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
        /// <summary>Non-visual components for the tray (§7.3).</summary>
        public List<TrayComponent> Tray { get; init; } = new();
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
        public int TotalStatements { get; init; }
        public int Representable { get; init; }
        public List<string> Unrepresentable { get; init; } = new();
        /// <summary>Hit-test map, innermost-first (deepest, then smallest area) — same order as <see cref="LayoutResult.Controls"/>.</summary>
        public List<LayoutControl> Controls { get; init; } = new();
        /// <summary>Non-visual components for the tray (§7.3).</summary>
        public List<TrayComponent> Tray { get; init; } = new();
    }
}
