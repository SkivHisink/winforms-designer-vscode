using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Windows.Forms;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Loads a .Designer.cs, reconstructs the component graph in a standalone
    /// DesignSurface (S1), interprets the representable InitializeComponent subset
    /// (S2b), and captures to PNG (S1/S4 fast-path). When a control assembly is
    /// supplied, custom/3rd-party control types are resolved from a collectible ALC
    /// so real custom controls render with full fidelity.
    /// </summary>
    public sealed class RenderResult
    {
        public byte[] Png { get; init; } = Array.Empty<byte>();
        public int Width { get; init; }
        public int Height { get; init; }
        public int TotalStatements { get; init; }
        public int Representable { get; init; }
        public string RootType { get; init; } = "";
        public List<string> Unrepresentable { get; init; } = new();
    }

    /// <summary>
    /// A single control rendered to PNG plus its placement, for dirty-region updates (S3): the host
    /// re-renders only the changed control (~0.3–1 ms, vs ~100 ms full-frame) and draws the patch at
    /// (X,Y) over the cached full frame.
    ///
    /// X/Y are in the FULL-FRAME (window) pixel space of the chrome-inclusive render, so the host draws
    /// the patch directly at (X,Y) — no extra offset math. The root patch is the whole window → (0,0).
    /// EXACT for direct children of the root (verified: full-frame crop at (X,Y,W,H) == this patch). A
    /// control nested in a container with its own client inset (GroupBox caption/border, bordered Panel)
    /// is off by that intermediate inset (≈1–3 px) — refined when nested compositing is needed.
    /// </summary>
    public sealed class ControlRenderResult
    {
        public byte[] Png { get; init; } = Array.Empty<byte>();
        public int X { get; init; }
        public int Y { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
        public bool Found { get; init; }
    }

    public static class DesignerRenderer
    {
        private static readonly Assembly[] ProbeAssemblies =
        {
            typeof(Control).Assembly,
            typeof(Color).Assembly,
            typeof(Point).Assembly,
            // System.Drawing.Common — hosts Font / FontStyle / GraphicsUnit / FontFamily, needed so the
            // interpreter can resolve (and the value-converter can emit) Font property values. Adding it
            // makes file-reading constructors (Bitmap/Icon/Metafile, all in System.Drawing) RESOLVABLE,
            // so the ObjectCreation gate below is a type-name allowlist (not a namespace check) to keep
            // those non-constructable from a hand-crafted .Designer.cs. See IsConstructionAllowed.
            typeof(Font).Assembly,
            typeof(object).Assembly,
        };

        public static byte[] RenderToPng(string designerFilePath, string? controlAssemblyPath = null) =>
            RenderDetailed(designerFilePath, controlAssemblyPath).Png;

        public static RenderResult RenderDetailed(string designerFilePath, string? controlAssemblyPath = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath);

            var root = (Control)g.Host.RootComponent;
            if (root.Width <= 0 || root.Height <= 0)
            {
                root.ClientSize = new Size(400, 300);
            }

            int w = Math.Max(root.Width, 1);
            int h = Math.Max(root.Height, 1);
            return new RenderResult
            {
                Png = CaptureRootPng(root, w, h),
                Width = w,
                Height = h,
                TotalStatements = g.Total,
                Representable = g.Representable,
                RootType = g.RootType.FullName ?? g.RootType.Name,
                Unrepresentable = g.Unrepresentable,
            };
        }

        /// <summary>Capture the whole root control to a PNG (S1/S4 fast-path) — shared by full-frame render
        /// (<see cref="RenderDetailed"/>) and the combined render+layout (<see cref="RenderWithLayout"/>).</summary>
        private static byte[] CaptureRootPng(Control root, int w, int h, int scale = 1)
        {
            if (scale > 1)
            {
                // High-DPI capture: scale the control tree UP by an integer factor so text and metrics are drawn at the
                // higher resolution (crisp) — a plain DrawToBitmap into a bigger bitmap would only upscale (blurry). Scale
                // mutates the tree, so restore it in finally; an integer factor keeps the up/down scaling exactly reversible.
                root.Scale(new SizeF(scale, scale));
                try
                {
                    using var big = new Bitmap(w * scale, h * scale, PixelFormat.Format32bppArgb);
                    root.DrawToBitmap(big, new Rectangle(0, 0, w * scale, h * scale));
                    using var msb = new MemoryStream();
                    big.Save(msb, ImageFormat.Png);
                    return msb.ToArray();
                }
                finally { root.Scale(new SizeF(1f / scale, 1f / scale)); }
            }
            using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            root.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }

        /// <summary>
        /// Render a SINGLE control (by edit id, "this" = root) to PNG plus its placement — the engine
        /// half of dirty-region updates (S3). Re-renders only the changed control via DrawToBitmap
        /// (~0.3–1 ms, flat in form size) instead of the whole frame (~100 ms at 300 controls), so a
        /// property edit / future drag can patch just the affected control. Compositing onto the cached
        /// full frame is the host's job (X/Y are root-client-relative; see <see cref="ControlRenderResult"/>).
        /// </summary>
        public static ControlRenderResult RenderControl(string designerFilePath, string componentId, string? controlAssemblyPath = null, string? sourceText = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            var root = (Control)g.Host.RootComponent;
            if (root.Width <= 0 || root.Height <= 0)
            {
                root.ClientSize = new Size(400, 300);
            }

            IComponent? target = (componentId is "this" or "")
                ? g.Host.RootComponent
                : g.Host.Container.Components.Cast<IComponent>().FirstOrDefault(c => c.Site?.Name == componentId);
            if (target is not Control ctrl)
            {
                return new ControlRenderResult { Found = false };
            }

            int w = Math.Max(ctrl.Width, 1);
            int h = Math.Max(ctrl.Height, 1);
            using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            ctrl.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);

            // Placement in the FULL-FRAME (window) pixel space, so the host draws the patch directly at
            // (X,Y) over the cached full frame — see ComputeWindowOffset (shared with DescribeLayout).
            var (x, y) = ComputeWindowOffset(ctrl, root);

            return new ControlRenderResult { Png = ms.ToArray(), X = x, Y = y, Width = w, Height = h, Found = true };
        }

        /// <summary>
        /// Top-left of a control in the FULL-FRAME (window) pixel space of the chrome-inclusive render —
        /// the single source of truth for BOTH the dirty-region patch placement (<see cref="RenderControl"/>)
        /// and the hit-test rectangles (<see cref="DescribeLayout"/>), so a click maps to exactly the area
        /// a patch would repaint. Root → (0,0); otherwise the sum of each ancestor's offset up to the root
        /// plus the form's client origin within the chrome (derived from window-vs-client size: symmetric
        /// side/bottom borders). Pixel-exact for direct children of the root; a control nested in a
        /// container with its own client inset (GroupBox caption/border) is off by that intermediate inset
        /// (≈1–3 px) — acceptable for selection, see <see cref="ControlRenderResult"/>.
        /// </summary>
        private static (int X, int Y) ComputeWindowOffset(Control ctrl, Control root)
        {
            if (ReferenceEquals(ctrl, root)) return (0, 0);
            int x = 0, y = 0;
            for (Control? c = ctrl; c != null && !ReferenceEquals(c, root); c = c.Parent)
            {
                x += c.Left;
                y += c.Top;
            }
            int originX = Math.Max(0, (root.Width - root.ClientSize.Width) / 2);
            int originY = Math.Max(0, (root.Height - root.ClientSize.Height) - originX);
            return (x + originX, y + originY);
        }

        /// <summary>
        /// Enumerate every control's window-space bounds (+ minimal tree info) — the read-side data layer
        /// behind click-to-select in the unified designer view. The host maps a click pixel to a component
        /// id by hit-testing these rectangles (controls are returned innermost-first: deepest depth, then
        /// smallest area, so the first rectangle containing the click is the visually-topmost control).
        /// Bounds use the exact transform of <see cref="RenderControl"/> (<see cref="ComputeWindowOffset"/>),
        /// so the selection rectangle and a later dirty-region patch line up. Non-Control components (timers,
        /// providers) are skipped — they have no on-screen rectangle. Ids match SetProperty/DescribeComponent
        /// ("this" = root, else Site.Name), so a hit-test result feeds straight into the property panel.
        /// </summary>
        public static LayoutResult DescribeLayout(string designerFilePath, string? controlAssemblyPath = null, string? sourceText = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            var root = (Control)g.Host.RootComponent;
            if (root.Width <= 0 || root.Height <= 0)
            {
                root.ClientSize = new Size(400, 300);
            }
            int frameW = Math.Max(root.Width, 1);
            int frameH = Math.Max(root.Height, 1);

            return new LayoutResult
            {
                RootType = g.RootType.FullName ?? g.RootType.Name,
                Width = frameW,
                Height = frameH,
                ClientWidth = root.ClientSize.Width,
                ClientHeight = root.ClientSize.Height,
                Controls = BuildLayoutControls(g, root, frameW, frameH),
                Tray = BuildTray(g, root),
                // Harvest AFTER Controls: forcing a per-strip PerformLayout can't change the already-built list.
                ToolStripItems = BuildToolStripItems(g, root),
            };
        }

        /// <summary>
        /// Render the full frame to PNG AND build the click-to-select hit-test map from ONE graph load —
        /// the combined <see cref="RenderDetailed"/> + <see cref="DescribeLayout"/> the unified designer's
        /// full render needs together. Issued as two RPCs, render and layout each re-parsed, re-interpreted
        /// and rebuilt the graph (the dominant cost on large forms); folding them halves that work. The
        /// returned Png/Width/Height and Controls are byte/field-identical to the two separate calls.
        /// </summary>
        public static RenderLayoutResult RenderWithLayout(string designerFilePath, string? controlAssemblyPath = null, string? sourceText = null, int renderScale = 1)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            var root = (Control)g.Host.RootComponent;
            if (root.Width <= 0 || root.Height <= 0)
            {
                root.ClientSize = new Size(400, 300);
            }
            int w = Math.Max(root.Width, 1);
            int h = Math.Max(root.Height, 1);

            // Build the hit-test map BEFORE drawing. DescribeLayout computes bounds on the freshly-loaded,
            // not-yet-painted surface, and DrawToBitmap can trigger a layout pass — so doing the (pure,
            // non-mutating) geometry reads first keeps Controls field-identical to a standalone DescribeLayout,
            // and capturing afterwards keeps the PNG byte-identical to a standalone RenderDetailed. The e2e
            // byte/field-equality leg pins both halves of that contract.
            var controls = BuildLayoutControls(g, root, w, h);
            var png = CaptureRootPng(root, w, h, renderScale);
            // Harvest item geometry AFTER the PNG capture: BuildToolStripItems forces a per-strip PerformLayout, and
            // doing it post-capture keeps the PNG byte-identical (DrawToBitmap already laid the strip out for free).
            var toolStripItems = BuildToolStripItems(g, root);

            return new RenderLayoutResult
            {
                Png = png,
                Width = w,
                Height = h,
                ClientWidth = root.ClientSize.Width,
                ClientHeight = root.ClientSize.Height,
                RootType = g.RootType.FullName ?? g.RootType.Name,
                InheritedBase = g.InheritedBase,
                BaseTypeName = g.BaseTypeName,
                UnrenderableResxCount = g.UnrenderableResxCount,
                TotalStatements = g.Total,
                Representable = g.Representable,
                Unrepresentable = g.Unrepresentable,
                Controls = controls,
                Tray = BuildTray(g, root),
                ToolStripItems = toolStripItems,
            };
        }

        /// <summary>
        /// Build every control's window-space hit-test rectangle (+ minimal tree info), innermost-first —
        /// the shared core of <see cref="DescribeLayout"/> and <see cref="RenderWithLayout"/> so the two
        /// can never diverge. Pure geometry reads (no surface mutation), using the exact transform of
        /// <see cref="RenderControl"/> (<see cref="ComputeWindowOffset"/>).
        /// </summary>
        private static List<LayoutControl> BuildLayoutControls(LoadedGraph g, Control root, int frameW, int frameH)
        {
            var controls = new List<LayoutControl>();
            foreach (IComponent comp in g.Host.Container.Components)
            {
                if (comp is not Control ctrl) continue;
                bool isRoot = ReferenceEquals(ctrl, root);

                // An OFF-TREE control (not the root, no parent) is a sited Control field that was never added to
                // any Controls collection — e.g. a ContextMenuStrip / ToolStripDropDown, which is edited via the
                // tray and shown as a popup, never placed on the form. It has no window position: ComputeWindowOffset
                // collapses to the chrome origin, so keeping it here drops a PHANTOM rect over the form's top-left
                // that (being small) sorts first and STEALS the hit-test from whatever really sits there (a menu bar).
                // It belongs in the component tray instead (BuildTray surfaces it, in lockstep). net48's Collect(root)
                // never reaches such a control, so skipping it also restores cross-runtime parity.
                if (!isRoot && ctrl.Parent == null) continue;

                // A control on a NON-active tab page is not on the shown surface (VS shows only the active tab's
                // contents; you switch tabs to reach the rest). Its rect stacks under the active page, so keeping it
                // would let it steal a hit-test from the control the user clicked. This is the tab-SELECTION case —
                // distinct from the Visible shadowing noted below (we still do NOT filter on ctrl.Visible).
                if (!isRoot && IsOnHiddenTab(ctrl, root)) continue;

                // NOTE: every Control is included (no Visible filter). On a design surface ControlDesigner
                // SHADOWS Visible/Enabled, so a design-time Visible=false control still has runtime
                // Visible==true and is still painted by DrawToBitmap (verified: render is byte-identical
                // with/without Visible=false) — exactly like Visual Studio, which keeps hidden controls
                // visible/selectable on the surface. So the hit-test map must include them too; filtering on
                // ctrl.Visible would (a) be a no-op here, and (b) wrongly drop a painted, selectable control.

                int depth = 0;
                for (Control? c = ctrl; c != null && !ReferenceEquals(c, root); c = c.Parent) depth++;

                string? parentId = null;
                if (!isRoot && ctrl.Parent is Control p)
                {
                    parentId = ReferenceEquals(p, root) ? "this" : (p.Site?.Name ?? "");
                }

                var (x, y) = ComputeWindowOffset(ctrl, root);
                controls.Add(new LayoutControl
                {
                    Id = isRoot ? "this" : (ctrl.Site?.Name ?? ""),
                    Name = isRoot ? g.ClassName : (ctrl.Site?.Name ?? ""),
                    Type = ctrl.GetType().FullName ?? ctrl.GetType().Name,
                    ParentId = parentId,
                    IsRoot = isRoot,
                    X = isRoot ? 0 : x,
                    Y = isRoot ? 0 : y,
                    Width = isRoot ? frameW : Math.Max(ctrl.Width, 1),
                    Height = isRoot ? frameH : Math.Max(ctrl.Height, 1),
                    Depth = depth,
                    TabIndex = isRoot ? -1 : ctrl.TabIndex,
                    Anchor = isRoot ? "None" : ctrl.Anchor.ToString(),
                    Dock = isRoot ? "None" : ctrl.Dock.ToString(),
                    // Only a strip PARENTED into the tree gets on-canvas item geometry (BuildToolStripItems skips
                    // parentless off-tree strips like a ContextMenuStrip), so keep the flag in lockstep — a future
                    // click-to-add path must not route into item mode for a strip with no slot.
                    IsStripHost = ctrl is ToolStrip && (isRoot || ctrl.Parent != null),
                });
            }

            // innermost-first: deepest control, then smallest area — the host takes the first rectangle
            // that contains the click as the visually-topmost target (the form/root, depth 0 and full
            // frame, is last so clicking empty form background selects the form).
            controls.Sort((a, b) =>
            {
                int d = b.Depth.CompareTo(a.Depth);
                if (d != 0) return d;
                return ((long)a.Width * a.Height).CompareTo((long)b.Width * b.Height);
            });

            return controls;
        }

        /// <summary>Width (horizontal strip) / height (vertical strip) of the synthesized trailing "Type Here" add-slot.</summary>
        private const int TypeHereExtent = 66;

        /// <summary>
        /// Per-item window-space geometry for every TOP-LEVEL ToolStrip/MenuStrip/StatusStrip item, plus a synthesized
        /// trailing "Type Here" slot per strip — the read side behind on-canvas item add/rename/delete. Only top-level
        /// items: a closed DropDown submenu isn't laid out, so its children have no meaningful <c>item.Bounds</c>.
        /// <para>item.Bounds is layout-COMPUTED (never serialized) and SuspendLayout/ResumeLayout are no-ops during
        /// interpret, so this forces a per-strip <c>PerformLayout()</c>. Call it AFTER <see cref="BuildLayoutControls"/>
        /// (and, in <see cref="RenderWithLayout"/>, AFTER the PNG capture) so forcing layout can't perturb the
        /// field-identical Controls list or the byte-identical PNG.</para>
        /// </summary>
        private static List<ToolStripItemBounds> BuildToolStripItems(LoadedGraph g, Control root)
        {
            var items = new List<ToolStripItemBounds>();
            foreach (IComponent comp in g.Host.Container.Components)
            {
                if (comp is not ToolStrip strip) continue;
                // Only strips PARENTED into the visual tree — a ContextMenuStrip / ToolStripDropDownMenu is a sited
                // field but has no parent chain (it's not in any control's Controls), so it's never painted on the
                // surface. Emitting a slot for it would drop a phantom "Type Here" over the form's top-left (its
                // ComputeWindowOffset is just the chrome origin). This matches the net48 engine, which only walks
                // Collect(root) and so never sees an off-tree strip.
                if (!ReferenceEquals(strip, root) && strip.Parent == null) continue;
                if (IsOnHiddenTab(strip, root)) continue;
                string ownerId = ReferenceEquals(strip, root) ? "this" : (strip.Site?.Name ?? "");
                if (ownerId.Length == 0) continue;              // unsited/internal strip → not addressable

                try { strip.PerformLayout(); } catch { /* layout hiccup → bounds may be default; skip below */ }
                var (ox, oy) = ComputeWindowOffset(strip, root);
                var disp = strip.DisplayRectangle;                     // the item-row area, in strip coords
                bool horizontal = strip.Orientation == Orientation.Horizontal;
                int contentEnd = horizontal ? disp.Left : disp.Top;   // running right/bottom edge of the last item
                var overflowItems = new List<ToolStripItemBounds>();   // items pushed off the main strip (Placement==Overflow)

                foreach (ToolStripItem it in strip.Items)
                {
                    if (!it.Available) continue;                       // hidden / overflow-collapsed → no on-strip rect
                    // An OVERFLOW-placed item isn't on the main strip (its Bounds live in the collapsed overflow dropdown),
                    // so it's harvested BOUNDS-LESS like a nested child and surfaced via the chevron's synthetic flyout below.
                    if (it.Placement == ToolStripItemPlacement.Overflow)
                    {
                        overflowItems.Add(new ToolStripItemBounds
                        {
                            OwnerId = ownerId,
                            ItemId = it.Site?.Name ?? it.Name ?? "",
                            ItemType = it.GetType().FullName ?? it.GetType().Name,
                            Text = it.Text ?? "",
                            IsTypeHere = false,
                            Children = BuildItemChildren(it, ownerId),
                        });
                        continue;
                    }
                    if (it.Placement != ToolStripItemPlacement.Main) continue; // Placement.None → not shown anywhere
                    var b = it.Bounds;                                 // strip-relative (same origin as ComputeWindowOffset)
                    items.Add(new ToolStripItemBounds
                    {
                        OwnerId = ownerId,
                        ItemId = it.Site?.Name ?? it.Name ?? "",
                        ItemType = it.GetType().FullName ?? it.GetType().Name,
                        Text = it.Text ?? "",                              // live caption → canvas prefills the rename editor
                        X = ox + b.X,
                        Y = oy + b.Y,
                        Width = Math.Max(b.Width, 1),
                        Height = Math.Max(b.Height, 1),
                        IsTypeHere = false,
                        Children = BuildItemChildren(it, ownerId),         // nested submenu → canvas synthetic flyout
                    });
                    contentEnd = Math.Max(contentEnd, horizontal ? b.Right : b.Bottom);
                }

                // The overflow chevron the ToolStrip paints at its edge: a bounds-carrying, id-less item whose Children
                // are the overflow-placed items. The canvas opens a synthetic flyout of them anchored at this rect. The
                // chevron is already in the PNG (a real button), so the canvas needs only the hit region, not an overlay.
                var ob = strip.OverflowButton;
                bool overflowing = overflowItems.Count > 0 && ob != null;
                if (overflowing)
                {
                    var obb = ob!.Bounds;                              // strip-relative, like item.Bounds (non-null: overflowing implies ob != null)
                    items.Add(new ToolStripItemBounds
                    {
                        OwnerId = ownerId,
                        ItemType = ob.GetType().FullName ?? ob.GetType().Name,
                        X = ox + obb.X,
                        Y = oy + obb.Y,
                        Width = Math.Max(obb.Width, 1),
                        Height = Math.Max(obb.Height, 1),
                        IsTypeHere = false,
                        Overflow = true,
                        Children = overflowItems,
                    });
                }

                // Synthesized "Type Here" slot just past the last item along the strip orientation. The cross-axis
                // placement (row top+height for horizontal, left+width for vertical) comes from DisplayRectangle — the
                // stable item-row band — NOT the last item, so a trailing Spring/separator/tall item can't skew it.
                // Suppressed when the strip is overflowing (it's full — there's no room; VS widens the strip to add).
                if (!overflowing)
                {
                    items.Add(horizontal
                        ? new ToolStripItemBounds { OwnerId = ownerId, IsTypeHere = true, X = ox + contentEnd + 2, Y = oy + disp.Top, Width = TypeHereExtent, Height = Math.Max(disp.Height, 1) }
                        : new ToolStripItemBounds { OwnerId = ownerId, IsTypeHere = true, X = ox + disp.Left, Y = oy + contentEnd + 2, Width = Math.Max(disp.Width, 1), Height = TypeHereExtent });
                }
            }
            return items;
        }

        /// <summary>Recursively collect a drop-down item's nested DropDownItems as BOUNDS-LESS <see cref="ToolStripItemBounds"/>
        /// (id/text/type + their own Children) for the canvas's synthetic submenu flyout — a closed dropdown isn't laid
        /// out, so children have no meaningful bounds; the canvas lays the flyout out itself and routes a child click
        /// through the item→Properties channel (which resolves a nested field-backed item by Site.Name). Gated on
        /// <c>HasDropDownItems</c> so it never forces a lazy dropdown to be created. OwnerId propagates the top-level
        /// strip id (the selectItem host context). Recursion depth is bounded by the (finite) menu tree.</summary>
        private static List<ToolStripItemBounds> BuildItemChildren(ToolStripItem item, string ownerId)
        {
            var kids = new List<ToolStripItemBounds>();
            if (item is ToolStripDropDownItem ddi && ddi.HasDropDownItems)
            {
                foreach (ToolStripItem child in ddi.DropDownItems)
                {
                    kids.Add(new ToolStripItemBounds
                    {
                        OwnerId = ownerId,
                        ItemId = child.Site?.Name ?? child.Name ?? "",
                        ItemType = child.GetType().FullName ?? child.GetType().Name,
                        Text = child.Text ?? "",
                        IsTypeHere = false,
                        Children = BuildItemChildren(child, ownerId),
                    });
                }
            }
            return kids;
        }

        /// <summary>True when the control descends through a tab page that is NOT the tab host's selected one — i.e.
        /// it's on a hidden tab and shouldn't be in the hit-test map. Reflective (TabPages collection + a
        /// SelectedTab/SelectedTabPage/SelectedPage) so it covers WinForms TabControl and any XtraTabControl-style
        /// host without a compile-time reference. Deliberately does NOT consider ctrl.Visible (design-time shadowing
        /// makes that a no-op / wrongly drops painted controls). Any reflection failure → false (keep the control).</summary>
        /// <summary>Find a public non-indexer property by name via a GetProperties() SCAN instead of
        /// Type.GetProperty(name), which throws AmbiguousMatchException when the property is `new`-shadowed with a
        /// covariant return (the DevExpress XtraTabControl pattern). Behaviorally identical for a singly-declared
        /// property (plain WinForms) — it only diverges by returning the shadowed property instead of throwing. Names
        /// are tried in order (mirrors a `GetProperty(a) ?? GetProperty(b)` chain).</summary>
        private static System.Reflection.PropertyInfo? FindTabProp(Type t, params string[] names)
        {
            foreach (var n in names)
                foreach (var p in t.GetProperties())
                    if (p.Name == n && p.GetIndexParameters().Length == 0) return p;
            return null;
        }

        private static bool IsOnHiddenTab(Control ctrl, Control root)
        {
            try
            {
                for (Control? c = ctrl; c != null && !ReferenceEquals(c, root); c = c.Parent)
                {
                    var parent = c.Parent;
                    if (parent == null) break;
                    var pagesProp = FindTabProp(parent.GetType(), "TabPages");
                    var selProp = FindTabProp(parent.GetType(), "SelectedTab", "SelectedTabPage", "SelectedPage");
                    if (pagesProp == null || selProp == null) continue;
                    if (pagesProp.GetValue(parent) is not System.Collections.IEnumerable pages) continue;
                    bool cIsPage = false;
                    foreach (var pg in pages) if (ReferenceEquals(pg, c)) { cIsPage = true; break; }
                    if (!cIsPage) continue;                       // c is an internal part, not one of the pages
                    var active = selProp.GetValue(parent) as Control;
                    if (active != null && !ReferenceEquals(active, c)) return true; // c is a non-selected page
                }
            }
            catch { return false; }
            return false;
        }

        /// <summary>
        /// The component tray: every host-container component that has no place on the visual surface — a
        /// non-Control (Timer, ToolTip, ErrorProvider, ImageList, BindingSource, …) OR an OFF-TREE Control that
        /// is a sited field yet was never added to any Controls collection (a ContextMenuStrip / ToolStripDropDown,
        /// which Visual Studio also shows in the tray). A PARENTED Control lives in the visual layout/hit-test map
        /// (BuildLayoutControls) and is skipped here, so the two read-paths never double-list the same component
        /// (BuildLayoutControls skips the off-tree Control in lockstep). The root form and the (unnamed) IContainer
        /// disposal holder are excluded. Pure reads; the host owns lifetime, so this never instantiates anything new.
        /// </summary>
        private static List<TrayComponent> BuildTray(LoadedGraph g, Control root)
        {
            var tray = new List<TrayComponent>();
            foreach (IComponent comp in g.Host.Container.Components)
            {
                if (ReferenceEquals(comp, root)) continue;
                if (comp is Control c && c.Parent != null) continue; // a PARENTED Control lives in the visual layout;
                                                                     // an off-tree Control (ContextMenuStrip) falls through
                if (comp is ToolStripItem) continue;                 // a field-backed strip item is a sited Component,
                                                                     // but Visual Studio never trays strip items — they are
                                                                     // edited on the strip itself (on-canvas Type Here / the
                                                                     // item editor). The tray holds only non-visual components
                                                                     // (Timer/ToolTip/…) + off-tree Controls (ContextMenuStrip).
                string id = comp.Site?.Name ?? "";
                if (id.Length == 0) continue;                 // unnamed/internal (e.g. the IContainer holder) → skip
                tray.Add(new TrayComponent
                {
                    Id = id,
                    Name = id,
                    Type = comp.GetType().FullName ?? comp.GetType().Name,
                    // An OFF-TREE ToolStrip (a ContextMenuStrip) carries its top-level Items so the canvas can open a
                    // synthetic flyout from its tray chip; a non-strip component leaves this empty.
                    Items = comp is ToolStrip strip ? BuildStripItemForest(strip, id) : new(),
                    IsStrip = comp is ToolStrip, // an EMPTY off-tree strip still opens an add-first-item flyout (Items alone can't distinguish it from a non-strip)
                });
            }
            tray.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return tray;
        }

        /// <summary>The top-level Items of an OFF-TREE ToolStrip (a tray ContextMenuStrip) as a BOUNDS-LESS forest — the
        /// tray-chip analogue of a top-level item's <see cref="BuildItemChildren"/>. The strip is never on the surface so
        /// there are no bounds; the canvas draws a synthetic flyout from the tray chip and routes a click through the
        /// item→Properties channel (each item resolves by Site.Name). <paramref name="ownerId"/> (the strip's id) is the
        /// host splice key for on-canvas add/rename/delete. Pure reads — the <c>HasDropDownItems</c>-gated recursion
        /// never forces a closed dropdown to be created, so it can run inside <see cref="BuildTray"/> without perturbing
        /// the byte-identical PNG.</summary>
        private static List<ToolStripItemBounds> BuildStripItemForest(ToolStrip strip, string ownerId)
        {
            var forest = new List<ToolStripItemBounds>();
            foreach (ToolStripItem it in strip.Items)
            {
                forest.Add(new ToolStripItemBounds
                {
                    OwnerId = ownerId,
                    ItemId = it.Site?.Name ?? it.Name ?? "",
                    ItemType = it.GetType().FullName ?? it.GetType().Name,
                    Text = it.Text ?? "",
                    IsTypeHere = false,
                    Children = BuildItemChildren(it, ownerId),
                });
            }
            return forest;
        }

        /// <summary>
        /// Load a .Designer.cs into a live design surface and serialize it back to
        /// InitializeComponent through the host serializer with default-value
        /// normalization. The save-direction half of the round-trip contract: proves
        /// open→save stays clean (no Enabled=true/Visible=true over-emission) while
        /// genuine non-defaults (Checked=true, custom Value=85) survive.
        /// </summary>
        public static RoundTripResult SerializeFromFile(string designerFilePath, string? controlAssemblyPath = null, bool normalizeDefaults = true)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath);
            RoundTripResult r;
            try
            {
                r = DesignerSerializer.Serialize(g.Surface, g.Host, g.ClassName, normalizeDefaults, g.ExplicitMembers, g.EventWiringStatements, g.SupportInitStatements);
            }
            catch (Exception ex)
            {
                // Some controls can LOAD/RENDER but cannot be CodeDom-serialized on .NET 9: the host
                // serializer pulls BinaryFormatter-backed resources (e.g. ToolStrip/MenuStrip), and
                // BinaryFormatter was removed in .NET 9 → "This platform does not support binary serialized
                // resources." The form still renders and accepts targeted text edits (--set-prop never
                // serializes); only the full normalize-save is impossible. Degrade to the safe-save read-only
                // fallback (treat the failure as an unrepresentable construct) instead of throwing out of
                // PreviewSave/SerializeDesigner/--roundtrip — a save crash on a common control is worse
                // than a clean read-only signal.
                var unrep = new List<string>(g.Unrepresentable) { $"serialize: {ex.GetType().Name}: {ex.Message}" };
                return new RoundTripResult
                {
                    Code = "",
                    RawCode = "",
                    ClassName = g.ClassName,
                    TotalStatements = g.Total,
                    Representable = g.Representable,
                    Unrepresentable = unrep,
                };
            }
            // carry interpret stats so the caller can enforce the safe-save read-only fallback
            return new RoundTripResult
            {
                Code = r.Code,
                RawCode = r.RawCode,
                ClassName = r.ClassName,
                DroppedDefaults = r.DroppedDefaults,
                TotalStatements = g.Total,
                Representable = g.Representable,
                Unrepresentable = g.Unrepresentable,
            };
        }

        /// <summary>
        /// Produce the would-be-saved text by splicing the normalized InitializeComponent
        /// back into the existing file (save-direction, normalization + transactional write). The result is a preview:
        /// the caller decides whether to write it. <see cref="SaveResult.Safe"/> is true only
        /// when the source fully round-trips — never write back otherwise.
        /// </summary>
        public static SaveResult SaveSplice(string designerFilePath, string? controlAssemblyPath = null)
        {
            var (encoding, original) = ReadWithEncoding(designerFilePath);
            var rt = SerializeFromFile(designerFilePath, controlAssemblyPath);
            if (!rt.RoundTripSafe)
            {
                return new SaveResult { RoundTrip = rt, OriginalText = original, Encoding = encoding, SplicedText = null };
            }
            // safe-save statement-level diff: refuse to save if re-serialization fails to reproduce
            // any original statement (would silently lose/alter user code), even when all interpreted.
            var missing = DesignerSaveSplicer.MissingOriginalStatements(original, rt.Code);
            if (missing.Count > 0)
            {
                return new SaveResult { RoundTrip = rt, OriginalText = original, Encoding = encoding, SplicedText = null, MissingStatements = missing };
            }
            string spliced = DesignerSaveSplicer.Splice(original, rt.Code).NewText;
            return new SaveResult { RoundTrip = rt, OriginalText = original, Encoding = encoding, SplicedText = spliced };
        }

        /// <summary>
        /// Enumerate a .Designer.cs into a description (controls + browsable properties with current
        /// values) — the read-side data layer for a property grid. Reuses the same load/interpret as
        /// render, so it sees exactly what the preview shows.
        /// </summary>
        public static DescribeResult Describe(string designerFilePath, string? controlAssemblyPath = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath);
            var mods = DesignerModifiers.ParseFieldModifiers(SafeRead(designerFilePath));
            return DesignerDescribe.Describe(g.Host, g.ClassName, g.ExplicitMembers, g.Total, g.Representable, g.Unrepresentable, g.EventWirings, mods);
        }

        /// <summary>Describe one component by edit id ("this" = root) — the bounded per-selection path for a grid.</summary>
        public static ComponentInfo? DescribeComponent(string designerFilePath, string componentId, string? controlAssemblyPath = null, string? sourceText = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            var mods = DesignerModifiers.ParseFieldModifiers(sourceText ?? SafeRead(designerFilePath));
            return DesignerDescribe.DescribeComponent(g.Host, g.ClassName, g.ExplicitMembers, componentId, g.EventWirings, mods);
        }

        /// <summary>Read a file's text for a describe pseudo-property parse; empty on any IO error (the pseudo-props
        /// simply won't be injected — describe still works).</summary>
        private static string SafeRead(string path)
        {
            try { return File.ReadAllText(path); }
            catch { return ""; }
        }

        /// <summary>
        /// Apply a targeted single-property edit to a source file (byte-minimal text edit,
        /// normalization sentinel). Verifies the result still parses and that ONLY the target (component,
        /// property) changed. Returns a preview — the caller decides to write.
        /// No rendering/assembly load needed: works even on files that don't fully round-trip.
        /// </summary>
        public static PropertyEditResult ApplyPropertyEdit(string designerFilePath, string componentName, string propertyName, string newValueExpr, string? sourceText = null)
        {
            // sourceText != null → edit the in-memory (unsaved) buffer; the host applies the result as a
            // WorkspaceEdit (no disk write), so the on-disk encoding is irrelevant here (default UTF-8).
            string src;
            Encoding encoding;
            if (sourceText != null)
            {
                src = sourceText;
                encoding = new UTF8Encoding(false);
            }
            else
            {
                (encoding, src) = ReadWithEncoding(designerFilePath);
            }
            var edit = DesignerPropertyEditor.EditProperty(src, componentName, propertyName, newValueExpr);
            if (edit.Mode == EditMode.Failed)
            {
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };
            }

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerPropertyEditor.OnlyTargetChanged(src, edit.NewText, componentName, propertyName, edit.Mode);
            bool safe = parseOk && minimal;

            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than the target property"),
            };
        }

        /// <summary>Safe-save-gated grid-cell edit: move a TableLayoutPanel child to a new column/row by swapping the cell
        /// args of its 3-arg <c>Controls.Add(this.child, col, row)</c>. Mirrors <see cref="ApplyPropertyEdit"/>
        /// (buffer-or-disk source, parse-check + <see cref="DesignerTableCellEditor.OnlyTableCellChanged"/> gate);
        /// column/row are plain ints, so no source is interpolated. Either may be null to keep the existing value.</summary>
        public static PropertyEditResult ApplyTableCellEdit(string designerFilePath, string childId, int? column, int? row, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            var edit = DesignerTableCellEditor.SetCell(src, childId, column, row);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerTableCellEditor.OnlyTableCellChanged(src, edit.NewText, childId);
            bool safe = parseOk && minimal;

            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than the target cell"),
            };
        }

        /// <summary>Reset one property to its default by deleting its assignment(s) — the engine side of VS's
        /// "Reset" and of Dock↔Anchor mutual exclusivity. Mirrors <see cref="ApplyPropertyEdit"/> (buffer-or-disk
        /// source; safe-save <see cref="DesignerPropertyEditor.OnlyPropertyReset"/> gate). Nothing is interpolated —
        /// only whole target-statement lines are removed. A property with no assignment is a safe no-op.</summary>
        public static PropertyResetResult ApplyPropertyReset(string designerFilePath, string componentName, string propertyName, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerPropertyEditor.ResetProperty(src, componentName, propertyName);
        }

        /// <summary>Import side of image/icon properties: embed the bytes into the form's sibling .resx and emit the
        /// <c>resources.GetObject</c> assignment (ensuring the resources local). Mirrors <see cref="ApplyPropertyEdit"/>
        /// (buffer-or-disk designer source; the host passes the current .resx text and applies both returned texts).
        /// Pure text + GDI+ decode-validation — no graph load / STA. See <see cref="DesignerImageEditor"/>.</summary>
        public static ImageResourceResult ApplyImageResource(string designerFilePath, string componentName, string propertyName,
            string propertyTypeName, byte[] imageBytes, string? resxText, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerImageEditor.SetImageResource(src, componentName, propertyName, propertyTypeName, imageBytes, resxText);
        }

        /// <summary>0.11.0 ImageList editor — embed a serialized ImageStream blob (from the net48 serializer) into the
        /// sibling .resx + rewrite the ImageList's init to the canonical ImageStream + SetKeyName form. Returns both new
        /// texts; the host persists them atomically + undoably.</summary>
        public static ImageListEditResult ApplySetImageList(string designerFilePath, string componentId,
            string imageStreamBase64, string[] keys, string? resxText, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerImageListEditor.SetImages(src, componentId, resxText, imageStreamBase64, keys);
        }

        /// <summary>Safe-save-gated TableLayoutPanel column/row size-style edit: rewrite the Nth ColumnStyle/RowStyle ctor args to
        /// (SizeType, value). Mirrors <see cref="ApplyTableCellEdit"/> (buffer-or-disk, parse-check +
        /// <see cref="DesignerTableStyleEditor.OnlyTableStyleChanged"/> gate); SizeType is a validated enum member and
        /// value a plain number, so no source is interpolated. sizeType/value may be null to keep the existing one.</summary>
        public static PropertyEditResult ApplyTableStyleEdit(string designerFilePath, string panelId, string axis, int index, string? sizeType, double? value, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            var edit = DesignerTableStyleEditor.SetStyle(src, panelId, axis, index, sizeType, value);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerTableStyleEditor.OnlyTableStyleChanged(src, edit.NewText, panelId, axis, index);
            bool safe = parseOk && minimal;

            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than the target style"),
            };
        }

        /// <summary>Read a TableLayoutPanel's ordered column + row sizing styles (read side for a style editor).
        /// Pure text parse of the InitializeComponent — no graph load / STA.</summary>
        public static TableStylesResult ReadTableStyles(string designerFilePath, string panelId, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerTableStyleEditor.ReadStyles(src, panelId);
        }

        /// <summary>Read a string-collection's current items (ComboBox/ListBox/CheckedListBox.Items) for the
        /// collection editor. Pure text parse of InitializeComponent — no graph load / STA.</summary>
        public static CollectionItemsResult ListCollectionItems(string designerFilePath, string ownerId, string propertyName, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerCollectionEditor.ListItems(src, ownerId, propertyName);
        }

        /// <summary>Set a string-collection's items (VS "String Collection Editor"): rewrite the owner's
        /// Add/AddRange calls to exactly <paramref name="items"/>. Mirrors <see cref="ApplyPropertyEdit"/>
        /// (buffer-or-disk source, parse-check + <see cref="DesignerCollectionEditor.OnlyCollectionChanged"/>
        /// gate); items are emitted as escaped string literals, so nothing is interpolated.</summary>
        public static PropertyEditResult ApplyCollectionEdit(string designerFilePath, string ownerId, string propertyName, IReadOnlyList<string> items, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            var edit = DesignerCollectionEditor.SetItems(src, ownerId, propertyName, items);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerCollectionEditor.OnlyCollectionChanged(src, edit.NewText, ownerId, propertyName);
            bool safe = parseOk && minimal;

            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than the target collection"),
            };
        }

        /// <summary>Read a generic <c>string[]</c> property's current items (TextBox/RichTextBox.Lines) for the
        /// string-array editor. Pure text parse of InitializeComponent — no graph load / STA.</summary>
        public static CollectionItemsResult ListStringArray(string designerFilePath, string ownerId, string propertyName, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerStringArrayEditor.ListArray(src, ownerId, propertyName);
        }

        /// <summary>Set a generic <c>string[]</c> property (TextBox/RichTextBox.Lines): rewrite its value to the
        /// single canonical assignment <c>owner.prop = new string[] { … }</c>. Builds the escaped single-line RHS
        /// (<see cref="DesignerStringArrayEditor.BuildArrayExpr"/>) then DELEGATES to the proven single-assignment
        /// splice (<see cref="ApplyPropertyEdit"/> → <see cref="DesignerPropertyEditor.EditProperty"/> +
        /// <see cref="DesignerPropertyEditor.OnlyTargetChanged"/> §6.5 gate) — NOT the collection Add/AddRange
        /// splicer, since a string[] property is a single assignment. Values are literals, so nothing is interpolated.</summary>
        public static PropertyEditResult ApplyStringArrayEdit(string designerFilePath, string ownerId, string propertyName, IReadOnlyList<string> items, string? sourceText = null)
        {
            // A content-backed property (TextBox/RichTextBox.Lines) is really stored in Text; write whichever
            // assignment is runtime-effective (Text = "joined" vs an existing Lines = new[]{…}) IN PLACE, so the
            // edit never introduces a competing assignment the other would silently override (data-loss guard).
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            var (targetProp, asArray) = DesignerStringArrayEditor.ResolveWriteTarget(src, ownerId, propertyName);
            string rhs = asArray ? DesignerStringArrayEditor.BuildArrayExpr(items) : DesignerStringArrayEditor.BuildTextLiteral(items);
            return ApplyPropertyEdit(designerFilePath, ownerId, targetProp, rhs, sourceText);
        }

        /// <summary>Read a ListView's current columns (ColumnHeader field id + Text/Width/TextAlign) for the typed
        /// collection editor. Pure text parse of InitializeComponent — no graph load / STA.</summary>
        public static ColumnItemsResult ListColumnItems(string designerFilePath, string ownerId, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerListColumnEditor.ListColumns(src, ownerId);
        }

        /// <summary>Set a ListView's columns (the typed counterpart of <see cref="ApplyCollectionEdit"/>): reconcile
        /// the field declarations, per-column construction/property statements and <c>Columns.AddRange</c> to exactly
        /// <paramref name="columns"/>. Same buffer-or-disk source + parse-check + <see cref="DesignerListColumnEditor.OnlyColumnsChanged"/>
        /// gate; values are emitted as literals/enum members, so nothing is interpolated.</summary>
        public static PropertyEditResult ApplyColumnsEdit(string designerFilePath, string ownerId, IReadOnlyList<ColumnItem> columns, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            var edit = DesignerListColumnEditor.SetColumns(src, ownerId, columns);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerListColumnEditor.OnlyColumnsChanged(src, edit.NewText, ownerId);
            bool safe = parseOk && minimal;

            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than the target columns"),
            };
        }

        /// <summary>Read a TreeView's current node forest (recursive: local id + Text/Name + children) for the
        /// hierarchical collection editor. Pure text parse of InitializeComponent — no graph load / STA.</summary>
        public static TreeNodeItemsResult ListNodeItems(string designerFilePath, string ownerId, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerTreeNodeEditor.ListNodes(src, ownerId);
        }

        /// <summary>Set a TreeView's nodes (the recursive counterpart of <see cref="ApplyColumnsEdit"/>): drop and
        /// regenerate the TreeNode local declarations + <c>Nodes.AddRange</c> in post-order to exactly
        /// <paramref name="nodes"/>. Same buffer-or-disk source + parse-check + <see cref="DesignerTreeNodeEditor.OnlyTreeNodesChanged"/>
        /// gate; Text/Name are emitted as literals, so nothing is interpolated.</summary>
        public static PropertyEditResult ApplyNodesEdit(string designerFilePath, string ownerId, IReadOnlyList<TreeNodeItem> nodes, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            var edit = DesignerTreeNodeEditor.SetNodes(src, ownerId, nodes);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerTreeNodeEditor.OnlyTreeNodesChanged(src, edit.NewText, ownerId);
            bool safe = parseOk && minimal;

            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than the target nodes"),
            };
        }

        /// <summary>Read a ToolStrip/MenuStrip item tree (item field id + Text/Name/type + nested DropDownItems) for
        /// the "…" editor. Pure text parse of InitializeComponent — no graph load / STA.</summary>
        public static ToolStripItemsResult ListToolStripItems(string designerFilePath, string ownerId, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerToolStripItemEditor.ListItems(src, ownerId);
        }

        /// <summary>Reorder, ADD to, REMOVE from, and/or RENAME items of a ToolStrip/MenuStrip item tree: rewrite each
        /// <c>Items</c>/<c>DropDownItems</c> AddRange to exactly <paramref name="items"/> (an empty-Id item is synthesized
        /// as a new field + construction + Name/Text; an omitted item is deleted with its whole subtree; an existing
        /// item's changed non-empty Text rewrites its <c>Text = "…"</c> literal in place), leaving every other surviving
        /// statement byte-identical. Same buffer-or-disk source + parse-check +
        /// <see cref="DesignerToolStripItemEditor.OnlyItemsChanged"/> gate.</summary>
        public static PropertyEditResult ApplyToolStripItemsEdit(string designerFilePath, string ownerId, IReadOnlyList<ToolStripItemModel> items, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            var edit = DesignerToolStripItemEditor.SetItems(src, ownerId, items);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerToolStripItemEditor.OnlyItemsChanged(src, edit.NewText);
            bool safe = parseOk && minimal;

            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than adding/removing/renaming/reordering items"),
            };
        }

        /// <summary>Read a DataGridView's current columns (field id + HeaderText/Width/ReadOnly/Visible) for the
        /// typed grid-column editor. Pure text parse of InitializeComponent — no graph load / STA.</summary>
        public static GridColumnItemsResult ListGridColumnItems(string designerFilePath, string ownerId, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerGridColumnEditor.ListColumns(src, ownerId);
        }

        /// <summary>Set a DataGridView's columns (VS "Collection Editor"): reconcile field declarations, per-column
        /// construction/property statements and Columns.AddRange to exactly <paramref name="columns"/>. Same
        /// buffer-or-disk source + parse-check + <see cref="DesignerGridColumnEditor.OnlyColumnsChanged"/> gate.</summary>
        public static PropertyEditResult ApplyGridColumnsEdit(string designerFilePath, string ownerId, IReadOnlyList<GridColumnItem> columns, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            var edit = DesignerGridColumnEditor.SetColumns(src, ownerId, columns);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerGridColumnEditor.OnlyColumnsChanged(src, edit.NewText, ownerId);
            bool safe = parseOk && minimal;

            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than the target columns"),
            };
        }

        /// <summary>
        /// VS-style "create event handler": for the given component+event, add the wiring statement to
        /// InitializeComponent (.Designer.cs) AND a matching empty handler stub to the code-behind (.cs),
        /// so a double-click on an unwired event creates the handler and can then navigate into it. Loads
        /// the graph only to reflect the event's delegate signature (so the stub has the right parameters).
        /// Returns BOTH new file texts (host applies them as unsaved WorkspaceEdits); null text = no change.
        /// If the event is already wired, the designer is left alone and only a missing stub is generated.
        /// </summary>
        public static EventGenResult GenerateEventHandler(
            string designerFilePath, string componentId, string eventName,
            string? handlerName, string? designerSourceText, string? codeText, string? controlAssemblyPath = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, designerSourceText);

            bool isRoot = componentId is "this" or "";
            System.ComponentModel.IComponent? comp = isRoot
                ? g.Host.RootComponent
                : g.Host.Container.Components.Cast<System.ComponentModel.IComponent>().FirstOrDefault(c => c.Site?.Name == componentId);
            if (comp == null) return new EventGenResult { Safe = false, Reason = "component not found: " + componentId };

            var ed = System.ComponentModel.TypeDescriptor.GetEvents(comp)[eventName];
            var del = ed?.EventType;
            var invoke = del?.GetMethod("Invoke");
            if (del == null || invoke == null) return new EventGenResult { Safe = false, Reason = "event/delegate not found: " + eventName };

            string compName = isRoot ? g.ClassName : (comp.Site?.Name ?? componentId);
            string idKey = isRoot ? "this" : compName;

            // already wired in the source? → don't add a second wiring; only generate a missing stub.
            string? existing = null;
            if (g.EventWirings.TryGetValue(idKey, out var wmap)) wmap.TryGetValue(eventName, out existing);

            if (existing != null)
            {
                bool needsStub = codeText != null && !DesignerEventEditor.HasMethod(codeText, g.ClassQualifiedName, existing);
                if (!needsStub)
                    return new EventGenResult { Safe = true, AlreadyWired = true, HandlerName = existing };
                var s0 = MakeStub(codeText!, g.ClassQualifiedName, existing, invoke);
                return new EventGenResult
                {
                    Safe = s0.Ok,
                    Reason = s0.Reason,
                    AlreadyWired = true,
                    HandlerName = existing,
                    CodeText = s0.NewText,
                    CodeInsertOffset = s0.InsertOffset,
                    CodeInsertText = s0.InsertText,
                    StubCreated = s0.Ok,
                };
            }

            // not wired: default handler name comp_Event (or the caller's, validated), wire it + stub it.
            string handler = handlerName != null && handlerName.Trim().Length > 0 ? handlerName.Trim() : compName + "_" + eventName;
            if (!DesignerEventEditor.IsValidIdentifier(handler))
                return new EventGenResult { Safe = false, HandlerName = handler, Reason = "handler name is not a valid identifier: " + handler };
            // refuse to WIRE an event with no code-behind to hold its handler: that would leave the
            // .Designer.cs referencing a method that doesn't exist (a compile error, hard to undo).
            if (codeText == null)
                return new EventGenResult { Safe = false, HandlerName = handler, Reason = "no code-behind (.cs) to place the handler" };

            string designerSrc = designerSourceText ?? File.ReadAllText(designerFilePath);
            // The delegate's own name goes into `+= new <delegateFqn>(this.h)`. CSharpType returns null for a type it
            // can't spell (a delegate nested in a generic outer, …) — splicing that null would emit `new (this.h)`.
            string? delegateFqn = CSharpType(del);
            if (delegateFqn == null)
                return new EventGenResult { Safe = false, HandlerName = handler, Reason = "the event's delegate type can't be written faithfully in C# here: " + (del.FullName ?? del.Name) };
            var wire = DesignerEventEditor.WireEvent(designerSrc, idKey, eventName, delegateFqn, handler);
            if (wire.Mode == EditMode.Failed)
                return new EventGenResult { Safe = false, Reason = wire.Reason, HandlerName = handler };

            bool parseOk = !CSharpSyntaxTree.ParseText(wire.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool wiringOk = DesignerEventEditor.OnlyWiringAdded(designerSrc, wire.NewText, idKey, eventName);
            if (!parseOk || !wiringOk)
                return new EventGenResult { Safe = false, HandlerName = handler, Reason = !parseOk ? "wired text has syntax errors" : "wiring changed more than the target event" };

            string? newCode = null;
            int insertAt = -1;
            string? insertText = null;
            bool stubCreated = false;
            if (!DesignerEventEditor.HasMethod(codeText, g.ClassQualifiedName, handler))
            {
                var stub = MakeStub(codeText, g.ClassQualifiedName, handler, invoke);
                if (!stub.Ok)
                    return new EventGenResult { Safe = false, HandlerName = handler, Reason = "stub: " + stub.Reason };
                newCode = stub.NewText;
                insertAt = stub.InsertOffset;
                insertText = stub.InsertText;
                stubCreated = true;
            }

            return new EventGenResult
            {
                Safe = true,
                HandlerName = handler,
                AlreadyWired = false,
                DesignerText = wire.NewText,
                CodeText = newCode,
                CodeInsertOffset = insertAt,
                CodeInsertText = insertText,
                StubCreated = stubCreated,
            };
        }

        /// <summary>
        /// List the existing code-behind methods compatible (by parameter types + void-ness) with each of a
        /// component's events — the data behind the events dropdown. Returns eventName → candidate method
        /// names, only for events that HAVE at least one candidate. Empty when there is no code-behind.
        /// </summary>
        public static List<EventCandidates> ListHandlerCandidates(
            string designerFilePath, string componentId, string? designerSourceText, string? codeText, string? controlAssemblyPath = null)
        {
            var list = new List<EventCandidates>();
            if (codeText == null) return list;
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, designerSourceText);
            bool isRoot = componentId is "this" or "";
            System.ComponentModel.IComponent? comp = isRoot ? g.Host.RootComponent
                : g.Host.Container.Components.Cast<System.ComponentModel.IComponent>().FirstOrDefault(c => c.Site?.Name == componentId);
            if (comp == null) return list;

            // events share delegate types, so match the code-behind once per DISTINCT signature
            var bySig = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            foreach (System.ComponentModel.EventDescriptor ed in System.ComponentModel.TypeDescriptor.GetEvents(comp))
            {
                if (!ed.IsBrowsable) continue;
                var invoke = ed.EventType?.GetMethod("Invoke");
                if (invoke == null) continue;
                // FULL names: a candidate whose parameter is WRITTEN qualified must match the real namespace too.
                // Simple names let a user's own `Custom.EventArgs` pass as `System.EventArgs`, so the dropdown offered
                // a handler that is not compatible with EventHandler — wiring it stopped the project compiling.
                var pnames = invoke.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList();
                bool isVoid = invoke.ReturnType == typeof(void);
                string retName = invoke.ReturnType.FullName ?? invoke.ReturnType.Name;
                // Cache key on the ASSEMBLY-QUALIFIED name: two referenced assemblies can define the same
                // Namespace.EventArgs, and keying on FullName alone would reuse the first event's candidate list for
                // the second — a different type, same key.
                string sig = (isVoid ? "v:" : "r:") + string.Join(",",
                    invoke.GetParameters().Select(p => p.ParameterType.AssemblyQualifiedName ?? p.ParameterType.FullName ?? p.ParameterType.Name));
                if (!bySig.TryGetValue(sig, out var cands))
                {
                    cands = DesignerEventEditor.FindCompatibleHandlers(codeText, g.ClassQualifiedName, pnames, retName);
                    bySig[sig] = cands;
                }
                if (cands.Count > 0) list.Add(new EventCandidates { Event = ed.Name, Handlers = cands });
            }
            return list;
        }

        /// <summary>
        /// Wire / rewire / unwire an event to an EXISTING code-behind handler (the events dropdown write
        /// path). Edits only the .Designer.cs. handlerName null → unwire. When non-null, the method must
        /// already exist in the code-behind (codeText) — wiring to a missing method would not compile.
        /// </summary>
        public static EventWiringResult SetEventWiring(
            string designerFilePath, string componentId, string eventName, string? handlerName,
            string? designerSourceText, string? codeText, string? controlAssemblyPath = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, designerSourceText);
            bool isRoot = componentId is "this" or "";
            System.ComponentModel.IComponent? comp = isRoot ? g.Host.RootComponent
                : g.Host.Container.Components.Cast<System.ComponentModel.IComponent>().FirstOrDefault(c => c.Site?.Name == componentId);
            if (comp == null) return new EventWiringResult { Safe = false, Reason = "component not found: " + componentId };
            var ed = System.ComponentModel.TypeDescriptor.GetEvents(comp)[eventName];
            var del = ed?.EventType;
            if (del == null) return new EventWiringResult { Safe = false, Reason = "event not found: " + eventName };

            string idKey = isRoot ? "this" : (comp.Site?.Name ?? componentId);
            string? handler = handlerName != null && handlerName.Trim().Length > 0 ? handlerName.Trim() : null;
            bool wired = g.EventWirings.TryGetValue(idKey, out var wmap) && wmap.ContainsKey(eventName);

            if (handler == null && !wired)
                return new EventWiringResult { Safe = false, Reason = "event is not wired" };
            // Wiring to a method that doesn't exist would not compile — but neither does wiring to one whose SIGNATURE
            // isn't the delegate's. This checked existence by NAME only, so `void WrongClick(string text)` could be
            // wired to Click and the build broke. The dropdown already filters by signature; this is the write
            // path, which the panel can reach with any value, so it must apply the SAME rule rather than trust it.
            if (handler != null && codeText != null)
            {
                var invoke = del.GetMethod("Invoke");
                if (invoke == null)
                    return new EventWiringResult { Safe = false, Reason = "event delegate has no Invoke: " + eventName };
                var pnames = invoke.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList();
                var compatible = DesignerEventEditor.FindCompatibleHandlers(
                    codeText, g.ClassQualifiedName, pnames, invoke.ReturnType.FullName ?? invoke.ReturnType.Name);
                if (!compatible.Contains(handler, StringComparer.Ordinal))
                    return new EventWiringResult
                    {
                        Safe = false,
                        Reason = DesignerEventEditor.HasMethod(codeText, g.ClassQualifiedName, handler)
                            ? "handler '" + handler + "' does not match the event's signature"
                            : "handler method not found in code-behind: " + handler,
                    };
            }

            int delta = handler == null ? -1 : (wired ? 0 : 1);
            string src = designerSourceText ?? File.ReadAllText(designerFilePath);
            string? delegateFqn = CSharpType(del);
            if (delegateFqn == null)
                return new EventWiringResult { Safe = false, Reason = "the event's delegate type can't be written faithfully in C# here: " + (del.FullName ?? del.Name) };
            var edit = DesignerEventEditor.SetEventWiring(src, idKey, eventName, handler, delegateFqn);
            if (edit.Mode == EditMode.Failed)
                return new EventWiringResult { Safe = false, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = DesignerEventEditor.OnlyWiringChanged(src, edit.NewText, idKey, eventName, delta);
            if (!parseOk || !gateOk)
                return new EventWiringResult { Safe = false, Reason = !parseOk ? "wiring text has syntax errors" : "wiring changed more than the target event" };
            return new EventWiringResult { Safe = true, DesignerText = edit.NewText, HandlerName = handler ?? "" };
        }

        /// <summary>
        /// Toolbox "add control": add a standard WinForms control to the .Designer.cs as a MINIMAL text edit
        /// (field declaration + InitializeComponent statements). Pure text — NO graph load (the generated
        /// statements are interpreted by the existing engine on the next render, which creates the control via
        /// host.CreateComponent). parentId "this" = the root form. The host applies the returned text unsaved.
        /// </summary>
        public static ControlAddResult AddControl(string designerFilePath, string parentId, string controlTypeKey, string? sourceText = null, int? locX = null, int? locY = null, string? controlAssemblyPath = null, IReadOnlyList<string>? projectControlFqns = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            // Fast path (curated/framework): pure text, NO assembly load. Only a project-control key
            // needs the project set to validate + resolve its full type name.
            IReadOnlyList<ToolboxItemInfo>? projectControls = null;
            if (!DesignerControlEditor.CanResolveWithoutProject(controlTypeKey))
            {
                if (projectControlFqns != null)
                {
                    // net48 (DevExpress/net4x) path: net9 can't load the vendor assembly, so the net48 engine
                    // enumerated its controls and handed their FQNs here. Trust those (each validated as a
                    // well-formed dotted type name — defense-in-depth so no crafted string reaches `new`) instead
                    // of a futile net9 ALC load. The emit stays pure text (`new <Fqn>()`) guarded by OnlyControlAdded.
                    var list = new List<ToolboxItemInfo>();
                    foreach (var f in projectControlFqns)
                        if (DesignerControlEditor.IsValidTypeName(f))
                            list.Add(new ToolboxItemInfo { Fqn = f, Name = f.Substring(f.LastIndexOf('.') + 1), Category = "Project Controls", FromProject = true });
                    projectControls = list;
                }
                else
                {
                    projectControls = EnumerateProjectControls(ResolveAsmForList(designerFilePath, controlAssemblyPath));
                }
            }
            return DesignerControlEditor.AddControl(src, parentId, controlTypeKey, projectControls, locX, locY);
        }

        /// <summary>Add a new empty tab page to a tab host (pure text edit; the caller supplies the page type,
        /// derived from an existing page). See <see cref="DesignerControlEditor.AddTabPage"/>.</summary>
        public static ControlAddResult AddTabPage(string designerFilePath, string hostId, string pageTypeFqn, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.AddTabPage(src, hostId, pageTypeFqn);
        }

        /// <summary>The toolbox's available control type keys (e.g. "Button", "Label", …).</summary>
        public static IReadOnlyList<string> ControlTypes() => DesignerControlEditor.ControlTypes;

        /// <summary>The auto-populated toolbox palette: framework controls always, plus the resolved
        /// project assembly's own controls (category "Project Controls") when a designer file is
        /// given. Framework discovery is pure reflection; project enumeration loads the assembly in a collectible
        /// ALC (cached per file mtime), reflects type names only (reload-safe), and never instantiates.</summary>
        public static IReadOnlyList<ToolboxItemInfo> ToolboxItems(string? designerFilePath = null, string? controlAssemblyPath = null)
        {
            var items = new List<ToolboxItemInfo>(DesignerControlEditor.ToolboxItems);
            items.AddRange(DesignerControlEditor.DiscoverComponents());   // Components/Dialogs (non-visual)
            if (!string.IsNullOrEmpty(designerFilePath) || !string.IsNullOrEmpty(controlAssemblyPath))
            {
                items.AddRange(EnumerateProjectControls(ResolveAsmForList(designerFilePath, controlAssemblyPath)));
            }
            return items;
        }

        /// <summary>Add a non-visual component (Timer/ToolTip/dialog…) to the .Designer.cs — the tray counterpart of
        /// <see cref="AddControl"/>. Pure text edit, no assembly load (components are framework-discovered).</summary>
        public static ControlAddResult AddComponent(string designerFilePath, string componentTypeKey, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.AddComponent(src, componentTypeKey);
        }

        /// <summary>Resolve the assembly to enumerate project controls from: an explicit override if it exists,
        /// else the auto-discovered project output (off-STA pre-warm path; allowEval:false to avoid MSBuild here).</summary>
        private static string? ResolveAsmForList(string? designerFilePath, string? controlAssemblyPath)
        {
            if (!string.IsNullOrEmpty(controlAssemblyPath) && File.Exists(controlAssemblyPath)) return controlAssemblyPath;
            if (string.IsNullOrEmpty(designerFilePath)) return null;
            try { return ProjectResolver.ResolveOutputAssembly(designerFilePath, allowEval: false); }
            catch { return null; }
        }

        private static readonly object _projCtlLock = new();
        private static readonly Dictionary<string, (long mtime, List<ToolboxItemInfo> items)> _projCtlCache = new();
        private static readonly Dictionary<string, (long mtime, ToolboxScanResult result)> _candidateCache = new();

        /// <summary>Enumerate the project assembly's own toolbox-eligible controls. Loads the
        /// assembly in a collectible ALC (shared assemblies deferred to Default so Control identity matches),
        /// reflects eligible types into strings, then unloads. Cached per (path, mtime). Returns [] on any failure
        /// (degrade to framework-only) — never throws. NO instantiation: GetTypes()/attributes only.</summary>
        public static List<ToolboxItemInfo> EnumerateProjectControls(string? asmPath)
        {
            if (string.IsNullOrEmpty(asmPath) || !File.Exists(asmPath)) return new List<ToolboxItemInfo>();
            string full = Path.GetFullPath(asmPath);
            long mtime;
            try { mtime = File.GetLastWriteTimeUtc(full).Ticks; } catch { mtime = 0; }
            // Hold the lock across the whole check-enumerate-store so two concurrent first-callers for the same
            // path don't each spin up a separate ALC and load the assembly twice (enumeration is rare + cached).
            lock (_projCtlLock)
            {
                if (_projCtlCache.TryGetValue(full, out var c) && c.mtime == mtime) return c.items;

                var items = new List<ToolboxItemInfo>();
                ControlLoadContext? alc = null;
                try
                {
                    alc = new ControlLoadContext(full);
                    var asm = alc.LoadFromAssemblyPath(full);
                    Type[] types;
                    try { types = asm.GetTypes(); }
                    catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray()!; }
                    foreach (var t in types)
                    {
                        if (t == null) continue;
                        try { if (DesignerControlEditor.IsEligibleToolboxControl(t)) items.Add(DesignerControlEditor.MakeProjectInfo(t)); }
                        catch { /* a type that throws on reflection is simply skipped */ }
                    }
                    items = items.GroupBy(i => i.Fqn, StringComparer.Ordinal).Select(g => g.First())
                                 .OrderBy(i => i.Name, StringComparer.Ordinal).ToList();
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[engine] project-control enumeration failed for {full}: {ex.GetType().Name}: {ex.Message}");
                    items = new List<ToolboxItemInfo>();
                }
                finally { alc?.Unload(); } // release the collectible context on EVERY exit (strings already extracted)
                _projCtlCache[full] = (mtime, items);
                return items;
            }
        }

        /// <summary>The "Choose Toolbox Items" rows: framework Controls+Components, plus the project assembly's
        /// own types, plus an optional browsed .dll the user picked. Pure reflection (collectible ALC for the
        /// project/browsed assemblies). LISTING only — never reaches AddControl's gate.</summary>
        public static List<ToolboxCandidate> ToolboxCandidates(string? designerFilePath, string? controlAssemblyPath, IReadOnlyList<string>? browseAssemblyPaths)
        {
            var list = new List<ToolboxCandidate>(DesignerControlEditor.FrameworkCandidates());
            var projAsm = ResolveAsmForList(designerFilePath, controlAssemblyPath);
            if (!string.IsNullOrEmpty(projAsm)) list.AddRange(EnumerateAssemblyCandidates(projAsm!, true));
            if (browseAssemblyPaths != null)
                foreach (var p in browseAssemblyPaths)
                    if (!string.IsNullOrEmpty(p)) list.AddRange(EnumerateAssemblyCandidates(p, false));
            return list
                .GroupBy(c => c.Namespace + "." + c.Name + "|" + c.AssemblyName, StringComparer.Ordinal).Select(g => g.First())
                .OrderBy(c => c.Name, StringComparer.Ordinal).ToList();
        }

        public static List<ToolboxCandidate> EnumerateAssemblyCandidates(string asmPath, bool fromProject)
            => ScanAssemblyCandidates(asmPath, fromProject).Items;

        /// <summary>Reflect one assembly's toolbox-eligible Control/Component types into Choose-Items rows via a
        /// collectible ALC (shared assemblies deferred to Default so Control/IComponent identity matches), then
        /// unload. Cached per (path, mtime). Captures a human-readable reason when nothing usable is found (so
        /// the dialog can tell the user) — never throws. NO instantiation: GetTypes()/attributes only.</summary>
        public static ToolboxScanResult ScanAssemblyCandidates(string asmPath, bool fromProject)
        {
            string simpleName = string.IsNullOrEmpty(asmPath) ? "" : Path.GetFileNameWithoutExtension(asmPath);
            if (string.IsNullOrEmpty(asmPath) || !File.Exists(asmPath))
                return new ToolboxScanResult { AssemblyName = simpleName, Error = "file not found" };
            string full = Path.GetFullPath(asmPath);
            long mtime; try { mtime = File.GetLastWriteTimeUtc(full).Ticks; } catch { mtime = 0; }
            lock (_projCtlLock)
            {
                if (_candidateCache.TryGetValue(full, out var c) && c.mtime == mtime) return c.result;
                ToolboxScanResult result;
                ControlLoadContext? alc = null;
                try
                {
                    alc = new ControlLoadContext(full);
                    var asm = alc.LoadFromAssemblyPath(full);
                    string asmName = asm.GetName().Name ?? simpleName;
                    Type[] types; string? loadWarn = null;
                    try { types = asm.GetTypes(); }
                    catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray()!; loadWarn = "some types could not be loaded (missing dependencies)"; }
                    var items = new List<ToolboxCandidate>();
                    foreach (var t in types)
                    {
                        if (t == null) continue;
                        try { if (DesignerControlEditor.IsToolboxDialogEligible(t)) items.Add(DesignerControlEditor.MakeCandidate(t, fromProject)); }
                        catch { /* a type that throws on reflection is simply skipped */ }
                    }
                    items = items.GroupBy(i => i.Namespace + "." + i.Name, StringComparer.Ordinal).Select(g => g.First())
                                 .OrderBy(i => i.Name, StringComparer.Ordinal).ToList();
                    result = new ToolboxScanResult
                    {
                        AssemblyName = asmName,
                        Items = items,
                        Error = items.Count == 0 ? (loadWarn ?? "no toolbox-eligible controls or components") : null,
                    };
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[engine] candidate enumeration failed for {full}: {ex.GetType().Name}: {ex.Message}");
                    string why = ex is BadImageFormatException ? "not a .NET assembly (or wrong architecture)"
                        : ex is FileLoadException ? "could not load (it may target .NET Framework or have missing dependencies)"
                        : $"{ex.GetType().Name}: {ex.Message}";
                    result = new ToolboxScanResult { AssemblyName = simpleName, Error = why };
                }
                finally { alc?.Unload(); }
                _candidateCache[full] = (mtime, result);
                return result;
            }
        }

        /// <summary>
        /// Remove a leaf control from the .Designer.cs (field declaration + its InitializeComponent
        /// statements) as a MINIMAL text edit. Pure text — no graph load. Refuses a container with children
        /// or a control referenced elsewhere (see <see cref="DesignerControlEditor.RemoveControl"/>).
        /// </summary>
        public static ControlRemoveResult RemoveControl(string designerFilePath, string controlId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.RemoveControl(src, controlId);
        }

        /// <summary>Remove a whole tab page (the page + its entire subtree) from a tab host as a MINIMAL text edit —
        /// deletes the subtree's fields/statements and detaches the page from the host's tab collection (whole
        /// Controls.Add/TabPages.Add, or a trimmed TabPages.AddRange element). Pure text, no graph load. See
        /// <see cref="DesignerControlEditor.RemoveTabPage"/>.</summary>
        public static ControlRemoveResult RemoveTabPage(string designerFilePath, string hostId, string pageId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.RemoveTabPage(src, hostId, pageId);
        }

        /// <summary>Reparent a leaf control into a different container / the root as a MINIMAL text edit —
        /// rewrites only the receiver of its Controls.Add. Pure text, no graph load. See
        /// <see cref="DesignerControlEditor.Reparent"/>.</summary>
        public static ControlReorderResult ReparentControl(string designerFilePath, string childId, string newParentId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.Reparent(src, childId, newParentId);
        }

        /// <summary>Copy a leaf control to an opaque clipboard blob (field type + its InitializeComponent
        /// statements). Pure text — no graph load. See <see cref="DesignerControlEditor.CopyControl"/>.</summary>
        public static ControlCopyResult CopyControl(string designerFilePath, string controlId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.CopyControl(src, controlId);
        }

        /// <summary>Paste a clipboard blob (from <see cref="CopyControl"/>) into a container as a fresh control.
        /// Pure text — no graph load. See <see cref="DesignerControlEditor.PasteControl"/>.</summary>
        public static ControlPasteResult PasteControl(string designerFilePath, string clip, string parentId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.PasteControl(src, clip, parentId);
        }

        /// <summary>Bring a control to front / send it to back by relocating its Controls.Add among its siblings.
        /// Pure text — no graph load. See <see cref="DesignerControlEditor.MoveZOrder"/>.</summary>
        public static ControlReorderResult MoveZOrder(string designerFilePath, string controlId, bool toFront, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.MoveZOrder(src, controlId, toFront);
        }

        /// <summary>Build a handler stub whose signature matches the event delegate's Invoke method.</summary>
        private static DesignerEventEditor.StubResult MakeStub(string code, string formClass, string handler, System.Reflection.MethodInfo invoke)
        {
            // dedupe parameter names (a malformed delegate could repeat one) so the stub always compiles.
            var used = new HashSet<string>(StringComparer.Ordinal);
            var parms = new List<(string type, string name)>();
            foreach (var p in invoke.GetParameters())
            {
                string n = string.IsNullOrEmpty(p.Name) ? ("arg" + p.Position) : p.Name!;
                string baseN = n;
                for (int k = 1; !used.Add(n); k++) n = baseN + "_" + k;
                string? pt = CSharpType(p.ParameterType);
                if (pt == null)
                    return new DesignerEventEditor.StubResult
                    {
                        Ok = false,
                        Reason = "the event's parameter type can't be written faithfully in C# here: "
                                 + (p.ParameterType.FullName ?? p.ParameterType.Name),
                    };
                parms.Add((pt, n));
            }
            string? rt = CSharpType(invoke.ReturnType);
            if (rt == null)
                return new DesignerEventEditor.StubResult
                {
                    Ok = false,
                    Reason = "the event's return type can't be written faithfully in C# here: "
                             + (invoke.ReturnType.FullName ?? invoke.ReturnType.Name),
                };
            return DesignerEventEditor.GenerateHandlerStub(code, formClass, handler, rt, parms);
        }

        /// <summary>C# name for a type, valid in a method signature without extra using directives: keyword for
        /// common built-ins, '.' for nested types (FullName uses '+'), and reconstructed Name&lt;Args&gt; for
        /// generics (FullName carries a grave-accent arity marker that isn't valid C#). NULL when the type can't be
        /// spelled faithfully — the caller must refuse rather than emit a stub that looks right and doesn't compile.</summary>
        private static string? CSharpType(Type t)
        {
            if (t == typeof(void)) return "void";
            if (t == typeof(object)) return "object";
            if (t == typeof(string)) return "string";
            if (t == typeof(bool)) return "bool";
            if (t == typeof(int)) return "int";
            if (t == typeof(long)) return "long";
            if (t == typeof(double)) return "double";
            if (t == typeof(float)) return "float";
            if (t.IsByRef || t.IsPointer || t.IsGenericParameter) return null; // can't be spelled faithfully here
            if (t.IsArray)
            {
                string? el = CSharpType(t.GetElementType()!);
                if (el == null) return null;
                // RANK matters: every array was spelled "[]", so a MULTIDIMENSIONAL `int[,]` parameter became `int[]`.
                // That parses, so the parse-only guard passed, the wiring was written, and the build failed on a
                // signature that isn't the delegate's. int[,] → "[,]", int[,,] → "[,,]"; jagged int[][] falls
                // out of the recursion (its element is itself an array).
                int rank = t.GetArrayRank();
                return el + "[" + new string(',', rank - 1) + "]";
            }
            if (t.IsGenericType)
            {
                string def = t.GetGenericTypeDefinition().FullName ?? t.Name;
                int lastPlus = def.LastIndexOf('+');
                // A type nested inside a GENERIC OUTER can't be spelled from FullName: GetGenericArguments() flattens
                // the whole chain's arguments into one list, and truncating at the FIRST backtick drops every nested
                // segment — `Vendor.Outer`1+ChangedArgs`1` came out as `Vendor.Outer<int, string>`, a different (or
                // nonexistent) type that still PARSED, so the wiring was written and the project didn't compile
                // Refuse those. Only an outer with arity is a problem: `Ns.Outer+Inner`1` (non-generic outer)
                // is perfectly spellable as `Ns.Outer.Inner<int>`, so look for a backtick at or before the last '+'
                // rather than anywhere — refusing on any '+' at all made a legitimate shape unusable.
                if (lastPlus >= 0 && def.LastIndexOf('`', lastPlus) >= 0) return null;
                int tick = def.IndexOf('`', lastPlus + 1);
                if (tick >= 0) def = def.Substring(0, tick);
                // '+' → '.': reflection's nested-type separator is not C#. Easy to forget here because the ACCEPTED
                // path only started carrying a '+' once the guard above was narrowed to "outer with arity" — before
                // that, any '+' was refused, so the missing Replace was invisible. Without it, a generic nested in a
                // plain outer emitted `Vendor.Outer+ChangedArgs<int>` into the user's .cs with Ok=true: not valid C#.
                def = def.Replace('+', '.');
                var args = t.GetGenericArguments().Select(CSharpType).ToList();
                if (args.Any(a => a == null)) return null;
                return def + "<" + string.Join(", ", args) + ">";
            }
            return (t.FullName ?? t.Name).Replace('+', '.');
        }

        /// <summary>
        /// Read a source file preserving its on-disk encoding/BOM so a save can write it back
        /// byte-faithfully (default WriteAllText strips a UTF-8 BOM that real
        /// VS designer files carry → whole-file churn). Handles UTF-8 ±BOM and UTF-16 LE/BE.
        /// </summary>
        /// <summary>Read a file's text with BOM/encoding detection (UTF-8/UTF-16 LE/BE), returning the encoding so a
        /// write-back preserves it. Public so the CLI edit paths (e.g. --set-modifier) can round-trip the encoding.</summary>
        public static (Encoding encoding, string text) ReadWithEncoding(string path)
        {
            byte[] b = File.ReadAllBytes(path);
            if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF)
            {
                var e = new UTF8Encoding(encoderShouldEmitUTF8Identifier: true);
                return (e, new UTF8Encoding(false).GetString(b, 3, b.Length - 3));
            }
            if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE)
            {
                return (Encoding.Unicode, Encoding.Unicode.GetString(b, 2, b.Length - 2));
            }
            if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF)
            {
                return (Encoding.BigEndianUnicode, Encoding.BigEndianUnicode.GetString(b, 2, b.Length - 2));
            }
            return (new UTF8Encoding(false), new UTF8Encoding(false).GetString(b));
        }

        /// <summary>A loaded design surface + interpretation stats; owns the surface lifetime.</summary>
        private sealed class LoadedGraph : IDisposable
        {
            public required DesignSurface Surface { get; init; }
            public required IDesignerHost Host { get; init; }
            public required Type RootType { get; init; }
            /// <summary>0.10.0 S2: the real base is an unresolved/inherited (user/vendor) type → net9 silently drops
            /// its controls. Surfaced as an honest banner (net9-only; net48 renders the real compiled type).</summary>
            public bool InheritedBase { get; init; }
            /// <summary>Name of the inherited/unresolved base (for the banner text); "" when the base resolved.</summary>
            public string BaseTypeName { get; init; } = "";
            /// <summary>0.10.0 S3: count of sibling-.resx resources this net9 preview can't render (binary/SOAP/
            /// ImageStream/FileRef/non-allowlisted). Drives the honest banner; net48 path reports 0.</summary>
            public int UnrenderableResxCount { get; init; }
            public required string ClassName { get; init; }
            /// <summary>The form's NAMESPACE-QUALIFIED name ("Product.Ui.Form1") — the identity used to find the same
            /// class in the paired code-behind. The simple name is not an identity: a .cs file may legally declare
            /// another class of that name in a different namespace, and matching by simple name offered/validated/
            /// wrote handlers in THAT class while the wiring went into this one — a non-compiling project reported as
            /// a successful save.</summary>
            public required string ClassQualifiedName { get; init; }
            public required List<Assembly> UserAsms { get; init; }
            public int Total { get; init; }
            public int Representable { get; init; }
            public required List<string> Unrepresentable { get; init; }
            public required HashSet<(IComponent, string)> ExplicitMembers { get; init; }
            /// <summary>Event wirings parsed from the source: component id ("this"/Site.Name) → (event → handler method).</summary>
            public required Dictionary<string, Dictionary<string, string>> EventWirings { get; init; }
            /// <summary>Verbatim event-wiring statements (this.X.Event += …) — re-emitted by the serializer so the
            /// round-trip preserves them exactly (they can't be wired to code-behind handlers on the surface).</summary>
            public required List<string> EventWiringStatements { get; init; }
            /// <summary>Verbatim ISupportInitialize BeginInit/EndInit brackets — re-emitted by the serializer so a form
            /// with them round-trips instead of forcing read-only (0.12.0 R1). The CodeDom serializer never produces
            /// them on its own; they're a representable no-op for render (see IsSupportInitBracket).</summary>
            public required List<string> SupportInitStatements { get; init; }
            public void Dispose() => Surface.Dispose();
        }

        /// <summary>
        /// Resolve the control assembly (explicit path → project auto-discovery), build a
        /// DesignSurface for the detected root type, and interpret the representable
        /// InitializeComponent subset into a live graph. Shared by render and serialize.
        /// </summary>
        private static LoadedGraph LoadGraph(string designerFilePath, string? controlAssemblyPath, string? sourceText = null)
        {
            // sourceText != null → render the in-memory (unsaved) buffer for a VS-style dirty preview; the
            // path is still used for project/assembly resolution (the file is open in the editor, so it
            // exists on disk even when its buffer differs). null → read the saved file from disk.
            string code;
            if (sourceText != null)
            {
                code = sourceText;
            }
            else
            {
                if (!File.Exists(designerFilePath))
                {
                    throw new FileNotFoundException("designer file not found", designerFilePath);
                }
                code = File.ReadAllText(designerFilePath);
            }
            var tree = CSharpSyntaxTree.ParseText(code);
            var rootNode = tree.GetRoot();
            // THE designer class — never just the first class in the file. Taking First() rendered whatever type
            // happened to be declared first (a helper/second class ahead of the form), reported it save-safe with no
            // banner, and let the splicer inject generated code into it; it also disagreed with the property editor
            // and save splicer, which both keyed off InitializeComponent. One shared rule now, and if the file
            // declares no designer class we fail closed rather than render an arbitrary one.
            var cls = DesignerModifiers.DesignerFormClass(rootNode, designerFilePath)
                ?? throw new InvalidOperationException(
                    "no single designer class in " + Path.GetFileName(designerFilePath)
                    + " — expected exactly one class declaring InitializeComponent");

            // resolve the control assembly: explicit override, else auto-discover the project build.
            // An explicit override that doesn't exist is a misconfiguration (typo, not-yet-built, wrong
            // dir) — fail loudly instead of silently reverting to auto-discovery, which is the very path
            // the caller set the override to bypass (the silent fallback rendered a wrong/partial form
            // with no signal). A null/blank override means "auto-discover".
            string? asmPath;
            if (!string.IsNullOrEmpty(controlAssemblyPath))
            {
                if (!File.Exists(controlAssemblyPath))
                {
                    throw new FileNotFoundException("configured control assembly not found", controlAssemblyPath);
                }
                asmPath = controlAssemblyPath;
            }
            else
            {
                // allowEval:false — never run the MSBuild subprocess on this (STA render) thread; consume
                // the pre-warmed cache or fall back to the bin search. The off-STA pre-warm did the eval.
                asmPath = ProjectResolver.ResolveOutputAssembly(designerFilePath, allowEval: false);
            }

            var userAsms = new List<Assembly>();
            if (!string.IsNullOrEmpty(asmPath) && File.Exists(asmPath))
            {
                string full = Path.GetFullPath(asmPath);
                // An unloadable resolved assembly (wrong runtime/bitness, corrupt PE — e.g. a single-target
                // net4x/higher-than-host output) must not abort the whole render: degrade to a framework-only
                // render as if nothing resolved, rather than throwing out of LoadGraph.
                try
                {
                    var alc = new ControlLoadContext(full);
                    userAsms.Add(alc.LoadFromAssemblyPath(full));
                    // also load sibling (non-shared) assemblies so types across the project resolve
                    string? outDir = Path.GetDirectoryName(full);
                    if (outDir != null)
                    {
                        foreach (var dll in Directory.GetFiles(outDir, "*.dll"))
                        {
                            if (string.Equals(dll, full, StringComparison.OrdinalIgnoreCase)) continue;
                            if (ControlLoadContext.IsSharedName(Path.GetFileNameWithoutExtension(dll))) continue;
                            try { userAsms.Add(alc.LoadFromAssemblyPath(dll)); } catch { /* skip non-loadable */ }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[engine] could not load resolved assembly {full}: {ex.GetType().Name}: {ex.Message}");
                    userAsms.Clear();
                }
            }

            var rootInfo = DetectRootType(cls, designerFilePath, userAsms);
            Type rootType = rootInfo.Surface;

            var surface = new DesignSurface();
            try
            {
                surface.BeginLoad(rootType);
                if (!surface.IsLoaded)
                {
                    throw new InvalidOperationException("DesignSurface failed to load root " + rootType.FullName);
                }
                var host = (IDesignerHost)surface.GetService(typeof(IDesignerHost))!;
                // resolve resources.GetObject(...) against the form's sibling .resx (image/icon properties).
                // null when there is no .resx → forms without resources are entirely unaffected.
                var resx = ResxResolver.TryLoadForDesigner(designerFilePath);
                var (total, ok, unrep, explicitMembers, eventWirings, supportInit) = Interpret(cls, host, userAsms, resx);

                return new LoadedGraph
                {
                    Surface = surface,
                    Host = host,
                    RootType = rootType,
                    InheritedBase = rootInfo.InheritedBase,
                    BaseTypeName = rootInfo.BaseTypeName,
                    // S3: computed from a SEPARATE size-independent metadata scan (NOT resx?.Count) so an oversized /
                    // unparseable .resx that TryLoadForDesigner refused still yields a truthful "incomplete" signal.
                    UnrenderableResxCount = ResxResolver.UnrenderableResourceCount(designerFilePath),
                    ClassName = cls.Identifier.Text,
                    ClassQualifiedName = FormClassResolver.QualifiedName(cls),
                    UserAsms = userAsms,
                    Total = total,
                    Representable = ok,
                    Unrepresentable = unrep,
                    ExplicitMembers = explicitMembers,
                    EventWirings = ExtractEventWirings(cls),
                    EventWiringStatements = eventWirings,
                    SupportInitStatements = supportInit,
                };
            }
            catch
            {
                surface.Dispose();
                throw;
            }
        }

        /// <summary>
        /// Load a user control assembly via a collectible ALC, instantiate the given
        /// control type on a design surface alongside a framework control, and render.
        /// Proves real custom-control rendering — not a placeholder.
        /// </summary>
        public static RenderResult RenderCustomControl(string assemblyPath, string typeName)
        {
            string full = Path.GetFullPath(assemblyPath);
            var alc = new ControlLoadContext(full);
            var asm = alc.LoadFromAssemblyPath(full);
            var ctlType = asm.GetType(typeName)
                ?? throw new InvalidOperationException("type not found in assembly: " + typeName);

            if (!typeof(Control).IsAssignableFrom(ctlType))
            {
                throw new InvalidOperationException(typeName + " is not a System.Windows.Forms.Control");
            }

            var surface = new DesignSurface();
            try
            {
                surface.BeginLoad(typeof(Form));
                if (!surface.IsLoaded)
                {
                    throw new InvalidOperationException("DesignSurface failed to load Form");
                }
                var host = (IDesignerHost)surface.GetService(typeof(IDesignerHost))!;
                var root = (Control)host.RootComponent;
                root.ClientSize = new Size(420, 220);

                var label = (Control)host.CreateComponent(typeof(Label), "captionLabel");
                label.Text = "Custom control loaded via collectible ALC:";
                label.Location = new Point(16, 12);
                label.Size = new Size(380, 20);
                root.Controls.Add(label);

                var custom = (Control)host.CreateComponent(ctlType, "customControl1");
                custom.Location = new Point(16, 44);
                root.Controls.Add(custom);

                int w = Math.Max(root.Width, 1);
                int h = Math.Max(root.Height, 1);
                using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
                root.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
                using var ms = new MemoryStream();
                bmp.Save(ms, ImageFormat.Png);

                return new RenderResult
                {
                    Png = ms.ToArray(),
                    Width = w,
                    Height = h,
                    RootType = "Form + " + ctlType.FullName,
                };
            }
            finally
            {
                surface.Dispose();
            }
        }

        /// <summary>
        /// Root-type classification: the framework <see cref="Surface"/> the interpreter loads (Form/UserControl),
        /// plus a fail-closed signal that the REAL base is an unresolved/inherited (user- or vendor-defined) type
        /// whose own InitializeComponent the net9 interpreter never replays — so the preview silently drops the
        /// base's controls. <see cref="BaseTypeName"/> names that base for the honest "preview may be incomplete"
        /// banner. net48 renders the real compiled type, so it has no such gap and emits no signal (0.10.0 S2).
        /// </summary>
        private readonly record struct RootTypeInfo(Type Surface, bool InheritedBase, string BaseTypeName);

        private static RootTypeInfo DetectRootType(
            ClassDeclarationSyntax cls, string designerFilePath, IReadOnlyList<Assembly> userAsms)
        {
            // Syntactic classification of the CURRENT source being interpreted (positive-evidence: null when no base
            // clause is found on the .Designer.cs or its sibling). The net9 render REPLAYS this source, so it is
            // authoritative for "does the source declare an inherited base" even when a stale build says otherwise.
            RootTypeInfo? syn = ClassifyFromBaseList(cls.BaseList, cls.SyntaxTree.GetRoot())
                ?? ClassifyFromSibling(cls, designerFilePath);

            // Reflect the compiled DERIVED type's REAL immediate base where a build exists — the only signal that sees a
            // cross-file / global-using base and a user type literally named "Form"/"UserControl".
            if (userAsms.Count > 0)
            {
                try
                {
                    Type? compiled = ResolveCompiledRoot(cls, userAsms);
                    if (compiled != null)
                    {
                        Type? baseT = compiled.BaseType;
                        bool reflResolved = IsFrameworkRoot(baseT); // immediate base IS Form/UserControl → nothing dropped
                        bool synInherited = syn is { InheritedBase: true };
                        // FAIL-CLOSED UNION: flag if EITHER the compiled base OR the current source base is non-framework.
                        // Reflection ALONE false-resolves against a STALE build (source added inheritance but wasn't
                        // rebuilt) while the source-interpreted render already drops the base's controls. When
                        // reflection resolves but the source flags, prefer the source's base name (the reflected base is
                        // the stale framework root; the source names the real new base).
                        bool inherited = !reflResolved || synInherited;
                        string baseName = !inherited ? ""
                            : !reflResolved ? (baseT?.FullName ?? baseT?.Name ?? "unknown")
                            : (syn?.BaseTypeName ?? "unknown");
                        return new RootTypeInfo(SurfaceFor(compiled), inherited, baseName);
                    }
                }
                catch { /* reflection hiccup → fall through to the syntactic result (fail-closed) */ }
            }

            // Buildless / type not found: the syntactic result, or today's default (Form, no banner) when there is no
            // base evidence anywhere (unreadable sibling + no build) — positive-evidence keeps plain forms un-bannered.
            return syn ?? new RootTypeInfo(typeof(Form), false, "");
        }

        // Build the derived type's reflection FQN (namespace(s) + nested-type '+' chain, WITH CLR generic arity `n so a
        // generic type isn't confused with a same-named nongeneric in a dependency) and resolve it against
        // the loaded user assemblies. Mirrors engine-net48/RootTypeResolver but walks every ancestor.
        private static Type? ResolveCompiledRoot(ClassDeclarationSyntax cls, IReadOnlyList<Assembly> userAsms)
        {
            string name = ReflectionSimpleName(cls);
            foreach (var anc in cls.Ancestors())
            {
                if (anc is ClassDeclarationSyntax outer) name = ReflectionSimpleName(outer) + "+" + name;
                else if (anc is BaseNamespaceDeclarationSyntax ns) name = ns.Name.ToString() + "." + name;
            }
            return ResolveType(name, userAsms);
        }

        // The two framework roots the interpreter can target with NOTHING dropped. Identity fast-path, else the type
        // must live in the REAL System.Windows.Forms assembly (a different-ALC WinForms is fine — same assembly name),
        // so a vendor type that merely REUSES the System.Windows.Forms.Form name via extern alias is rejected.
        private static bool IsFrameworkRoot(Type? t)
        {
            if (t == null) return false;
            if (t == typeof(Form) || t == typeof(UserControl)) return true;
            if (t.Assembly.GetName().Name != "System.Windows.Forms") return false;
            return t.FullName == "System.Windows.Forms.Form" || t.FullName == "System.Windows.Forms.UserControl";
        }

        // Best-effort render surface: walk the REAL base chain to the first framework root (assembly-checked → a
        // same-named vendor type never masquerades as the surface family).
        private static Type SurfaceFor(Type compiled)
        {
            for (Type? t = compiled; t != null; t = t.BaseType)
            {
                if (t.Assembly.GetName().Name != "System.Windows.Forms") continue;
                if (t.FullName == "System.Windows.Forms.UserControl") return typeof(UserControl);
                if (t.FullName == "System.Windows.Forms.Form") return typeof(Form);
            }
            return typeof(Form); // best-effort default (unchanged vs the pre-S2 fallback)
        }

        // EXACT-match classifier over the PARSED base-type node (not a ToString() substring, so comments/whitespace are
        // trivia and a vendor base like XtraForm never coincidentally matches). Resolves a SAME-FILE `using X = Type;`
        // alias first so `: U` (alias of a framework root) classifies correctly and picks the right surface.
        // null = "no base clause here" so the caller can chain to the sibling; a non-framework base → flagged inherited.
        private static RootTypeInfo? ClassifyFromBaseList(BaseListSyntax? baseList, SyntaxNode fileRoot)
        {
            if (baseList == null || baseList.Types.Count == 0) return null;
            var t = baseList.Types[0].Type; // C# requires the base CLASS first (interfaces follow) → [0] is it
            (string simple, string full) = ResolveAlias(SimpleName(t), t.ToString().Trim(), fileRoot);
            if (simple == "Form" || full == "System.Windows.Forms.Form") return new RootTypeInfo(typeof(Form), false, "");
            if (simple == "UserControl" || full == "System.Windows.Forms.UserControl") return new RootTypeInfo(typeof(UserControl), false, "");
            Type surface = simple.Contains("UserControl") ? typeof(UserControl) : typeof(Form);
            return new RootTypeInfo(surface, true, simple);
        }

        private static RootTypeInfo? ClassifyFromSibling(ClassDeclarationSyntax cls, string designerFilePath)
        {
            try
            {
                string? sibling = SiblingMainFile(designerFilePath);
                if (sibling != null && File.Exists(sibling))
                {
                    var sRoot = CSharpSyntaxTree.ParseText(File.ReadAllText(sibling)).GetRoot();
                    // Match the sibling class by FULLY-QUALIFIED name (namespace + nested chain), not just its short
                    // name, so an unrelated same-short-name type in another namespace can't classify this one.
                    string want = FormClassResolver.QualifiedName(cls);
                    foreach (var c in sRoot.DescendantNodes().OfType<ClassDeclarationSyntax>())
                    {
                        if (c.BaseList == null || FormClassResolver.QualifiedName(c) != want) continue;
                        var r = ClassifyFromBaseList(c.BaseList, sRoot);
                        if (r != null) return r;
                    }
                }
            }
            catch { /* unreadable sibling → let the caller fall back to Form */ }
            return null;
        }

        // Rightmost simple identifier of a base-type node, stripping namespace qualifiers (System.Windows.Forms.Form
        // → Form), alias qualifiers (global::…Form / Alias::Form → Form) and generic arity (BaseForm<T> → BaseForm).
        private static string SimpleName(TypeSyntax type) => type switch
        {
            QualifiedNameSyntax q => SimpleName(q.Right),
            AliasQualifiedNameSyntax a => SimpleName(a.Name),
            GenericNameSyntax g => g.Identifier.Text,
            IdentifierNameSyntax id => id.Identifier.Text,
            _ => type.ToString().Trim(),
        };

        // If `simple` is a SAME-FILE `using Alias = Target;` directive, return the target's (simple, full) names so an
        // aliased framework base classifies + picks the right surface. Cross-file / global-using aliases aren't visible
        // here (the reflection path covers those when a build exists). No matching alias → the inputs unchanged.
        private static (string simple, string full) ResolveAlias(string simple, string full, SyntaxNode fileRoot)
        {
            foreach (var u in fileRoot.DescendantNodes().OfType<UsingDirectiveSyntax>())
            {
                if (u.Alias?.Name.Identifier.Text == simple && u.Name is NameSyntax target)
                    return (SimpleName(target), target.ToString().Trim());
            }
            return (simple, full);
        }

        // CLR metadata name of a class syntax: `Foo` or `Foo`1` (generic arity) so a generic type isn't confused with a
        // same-named nongeneric when resolved by reflection.
        private static string ReflectionSimpleName(ClassDeclarationSyntax c)
        {
            int arity = c.TypeParameterList?.Parameters.Count ?? 0;
            return arity > 0 ? c.Identifier.Text + "`" + arity : c.Identifier.Text;
        }

        // Foo.Designer.cs → Foo.cs (the main partial holding the base clause). Null when not a .Designer.cs name.
        private static string? SiblingMainFile(string designerFilePath)
        {
            const string suffix = ".Designer.cs";
            if (designerFilePath.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
            {
                return designerFilePath.Substring(0, designerFilePath.Length - suffix.Length) + ".cs";
            }
            return null;
        }

        // ---- interpreter (from S2b, with user-assembly type resolution) ----

        /// <summary>
        /// Scan InitializeComponent for event wirings (<c>this.btn.Click += new EventHandler(this.btn_Click)</c>)
        /// and map component id ("this"/field name) → (event name → handler method). Read-only / source-level
        /// (the live design surface doesn't wire real handlers), used only to populate the Events tab — does
        /// NOT affect representability counts (event wirings remain non-representable for the save path).
        /// </summary>
        private static Dictionary<string, Dictionary<string, string>> ExtractEventWirings(ClassDeclarationSyntax cls)
        {
            var map = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
            var init = FormClassResolver.InitMethodOf(cls);
            if (init?.Body == null) return map;

            foreach (var stmt in init.Body.Statements)
            {
                if (stmt is not ExpressionStatementSyntax es) continue;
                if (es.Expression is not AssignmentExpressionSyntax asg) continue;
                if (!asg.OperatorToken.IsKind(SyntaxKind.PlusEqualsToken)) continue;
                if (asg.Left is not MemberAccessExpressionSyntax lhs) continue;

                string evt = lhs.Name.Identifier.Text;
                string comp = lhs.Expression switch
                {
                    MemberAccessExpressionSyntax inner => inner.Name.Identifier.Text, // this.comp.Event
                    ThisExpressionSyntax => "this",                                   // this.Event (root)
                    IdentifierNameSyntax idn => idn.Identifier.Text,                  // comp.Event
                    _ => "",
                };
                if (comp.Length == 0) continue;

                string? handler = ExtractHandlerName(asg.Right);
                if (handler == null) continue;

                if (!map.TryGetValue(comp, out var evts))
                {
                    evts = new Dictionary<string, string>(StringComparer.Ordinal);
                    map[comp] = evts;
                }
                evts[evt] = handler;
            }
            return map;
        }

        /// <summary>Handler method name from the RHS of an event wiring: <c>new EventHandler(this.M)</c>,
        /// <c>this.M</c>, or a bare <c>M</c> → "M"; null if not a recognizable method reference.</summary>
        private static string? ExtractHandlerName(ExpressionSyntax rhs)
        {
            ExpressionSyntax e = rhs;
            if (e is ObjectCreationExpressionSyntax oce && oce.ArgumentList is { Arguments.Count: > 0 } al)
            {
                e = al.Arguments[0].Expression;
            }
            return e switch
            {
                MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text, // this.Method
                IdentifierNameSyntax id => id.Identifier.Text,              // Method
                _ => null,
            };
        }

        /// <summary>The active resx resolution context (the `resources` local var name(s) + the loaded .resx),
        /// set for the duration of <see cref="Interpret"/>. Thread-static + scoped because the interpreter runs
        /// serialized on the single STA thread; <see cref="Eval"/> reads it to resolve resources.GetObject(...).</summary>
        [ThreadStatic] private static (HashSet<string> vars, ResxResolver? resolver)? _resx;

        private static (int total, int ok, List<string> unrep, HashSet<(IComponent, string)> explicitMembers, List<string> eventWirings, List<string> supportInit) Interpret(
            ClassDeclarationSyntax cls, IDesignerHost host, IReadOnlyList<Assembly> userAsms, ResxResolver? resx = null)
        {
            var root = (Control)host.RootComponent;
            var comps = new Dictionary<string, IComponent>(StringComparer.Ordinal);
            var unrep = new List<string>();
            // (component, property) pairs explicitly assigned in the source file. Lets the
            // serializer echo exactly the source's property set and not the extra
            // state the live designer/runtime assigns on its own (auto TabIndex, CheckState…).
            var explicitMembers = new HashSet<(IComponent, string)>();
            // Verbatim event-wiring statements (this.X.Event += …) captured for the serializer to re-emit exactly —
            // they can't be wired to the code-behind handlers on the surface, so we preserve them textually.
            var eventWirings = new List<string>();
            // Verbatim ISupportInitialize BeginInit/EndInit brackets captured for the serializer to re-emit exactly.
            // They are a representable no-op for RENDER (our static render sets properties directly), but the CodeDom
            // serializer does not produce them on its own, so we preserve them textually to make the form round-trip
            // instead of silently dropping the brackets (0.12.0 R1). Suspend/Resume, by contrast, are regenerated
            // canonically by the serializer and so are NOT captured here.
            var supportInit = new List<string>();
            int total = 0, ok = 0;

            // names of `IContainer components = new Container()` fields — lets a provider ctor
            // `new ToolTip(this.components)` be recognized (extenders) without opening general ctor-args.
            var containerNames = new HashSet<string>(StringComparer.Ordinal);

            // Across ALL of the form's partials, not just the one declaring InitializeComponent: a form may split its
            // component fields into a separate `partial class Foo { … }` in the same file, and scanning only `cls`
            // then left every `this.okButton…` statement unresolvable — a false read-only refusal on a valid file.
            var formParts = DesignerModifiers.PartialsOf(cls);
            var fieldNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var part in formParts)
            {
                foreach (var f in part.Members.OfType<FieldDeclarationSyntax>())
                {
                    foreach (var v in f.Declaration.Variables)
                    {
                        fieldNames.Add(v.Identifier.Text);
                    }
                }
            }

            // The form's InitializeComponent via the shared (class, method) rule — the class was resolved by the same
            // file, so the method the interpreter replays is provably the one the splicer rewrites.
            var init = FormClassResolver.InitMethodOf(cls);
            if (init?.Body == null)
            {
                unrep.Add("InitializeComponent not found");
                return (0, 0, unrep, explicitMembers, eventWirings, supportInit);
            }

            // find the `[System.ComponentModel.]ComponentResourceManager resources = new ...(typeof(Form))` local(s)
            // so Eval can resolve `resources.GetObject("...")` against the loaded .resx (image/icon properties).
            var resxVars = new HashSet<string>(StringComparer.Ordinal);
            foreach (var stmt in init.Body.Statements)
            {
                // match ONLY ComponentResourceManager — the exact form the WinForms designer emits. A bare
                // System.Resources.ResourceManager local could target a DIFFERENT resource set than the sibling
                // .resx, so routing its lookups here would render a wrong value.
                if (stmt is LocalDeclarationStatementSyntax lds
                    && LastTypeSegment(lds.Declaration.Type.ToString()) == "ComponentResourceManager")
                {
                    foreach (var v in lds.Declaration.Variables) resxVars.Add(v.Identifier.Text);
                }
            }

            // TreeView.Nodes: VS serializes tree nodes as LOCAL variables (not fields), so they never enter `comps`.
            // We build them into this side table as we walk the body (children are declared before their parents),
            // and attach them to the owning TreeView / parent node when we reach the `.Nodes.Add/AddRange(...)` call.
            var nodeMap = new Dictionary<string, System.Windows.Forms.TreeNode>(StringComparer.Ordinal);
            var treeNodeLocals = new HashSet<string>(StringComparer.Ordinal);

            var prevResx = _resx;
            _resx = (resxVars, resx);
            try
            {
                foreach (var stmt in init.Body.Statements)
                {
                    total++;
                    try
                    {
                        // TreeView.Nodes population (local `new TreeNode(...)` + `.Nodes.Add/AddRange`) is rendered by a
                        // self-contained builder — it only constructs TreeNode objects and sets side-effect-free value
                        // properties, so it stays outside the general Eval construction allowlist.
                        if (TryApplyTreeNodeStatement(stmt, nodeMap, treeNodeLocals, comps, userAsms)) { ok++; continue; }
                        if (stmt is ExpressionStatementSyntax es)
                        {
                            if (es.Expression is AssignmentExpressionSyntax asg)
                            {
                                // event wiring (this.X.Event += new Handler(this.method)): the handler lives in the
                                // code-behind, not on the design surface, so we don't (can't) wire it live — but it IS
                                // representable. Capture the VERBATIM statement so the serializer re-emits it exactly
                                // (round-trip safety: nothing is lost). A `+=`/`-=` whose LHS is not a real event
                                // is a hand-edit → stays unrepresentable.
                                if (asg.IsKind(SyntaxKind.AddAssignmentExpression) || asg.IsKind(SyntaxKind.SubtractAssignmentExpression))
                                {
                                    if (IsEventWiring(asg, root, comps)) { eventWirings.Add(stmt.ToString().Trim()); ok++; }
                                    else unrep.Add(stmt.ToString().Trim());
                                    continue;
                                }
                                HandleAssignment(asg, host, root, comps, fieldNames, containerNames, userAsms, explicitMembers);
                                ok++;
                                continue;
                            }
                            if (es.Expression is InvocationExpressionSyntax inv)
                            {
                                if (HandleInvocation(inv, root, comps, userAsms, out string? why))
                                {
                                    ok++;
                                    // Capture ISupportInitialize BeginInit/EndInit brackets verbatim so the serializer
                                    // re-emits them (round-trip): representable no-op for render, but must not be
                                    // silently dropped on save (0.12.0 R1).
                                    if (IsSupportInitBracket(inv)) supportInit.Add(stmt.ToString().Trim());
                                }
                                else unrep.Add(why ?? stmt.ToString().Trim());
                                continue;
                            }
                        }
                        // the `resources = new ComponentResourceManager(...)` declaration is representable — its
                        // effect (resource lookups) is honored via the .resx; it creates no component to drop.
                        if (stmt is LocalDeclarationStatementSyntax ld
                            && ld.Declaration.Variables.Any(v => resxVars.Contains(v.Identifier.Text)))
                        {
                            ok++;
                            continue;
                        }
                        unrep.Add(stmt.ToString().Trim());
                    }
                    catch (Exception ex)
                    {
                        unrep.Add(stmt.ToString().Trim() + "  [" + ex.GetType().Name + ": " + ex.Message + "]");
                    }
                }
            }
            finally { _resx = prevResx; }
            return (total, ok, unrep, explicitMembers, eventWirings, supportInit);
        }

        // ---- TreeView.Nodes rendering ------------------------------------------------------------------------------
        // VS serializes tree nodes as LOCAL variables inside InitializeComponent, bottom-up:
        //   TreeNode treeNode1 = new TreeNode("Apple");
        //   TreeNode treeNode2 = new TreeNode("Fruits", new TreeNode[] { treeNode1 });
        //   treeNode1.Name = "nodeApple";
        //   this.treeView1.Nodes.AddRange(new TreeNode[] { treeNode2 });
        // None of this touches the field `comps` graph, so the general dispatch drops it as unrepresentable (an empty
        // TreeView box). We render it with a self-contained builder that ONLY constructs TreeNode objects and sets a
        // small allowlist of side-effect-free value properties — no user code runs (TreeNode ctors/setters are pure),
        // so this deliberately stays out of the general Eval construction allowlist.
        private static readonly HashSet<string> TreeNodeSettableProps = new(StringComparer.Ordinal)
        {
            "Name", "Text", "ToolTipText", "ImageKey", "SelectedImageKey", "StateImageKey",
            "ImageIndex", "SelectedImageIndex", "StateImageIndex", "Checked", "ForeColor", "BackColor", "NodeFont", "Tag",
        };

        /// <summary>Renders one statement of a TreeView.Nodes population (a TreeNode local decl, a property assignment
        /// on such a local, or a <c>owner.Nodes.Add/AddRange(...)</c> call). Returns true when it handled the statement
        /// (so the caller counts it representable); false lets the general dispatch handle / flag it.</summary>
        private static bool TryApplyTreeNodeStatement(
            StatementSyntax stmt,
            Dictionary<string, System.Windows.Forms.TreeNode> nodeMap,
            HashSet<string> treeNodeLocals,
            Dictionary<string, IComponent> comps,
            IReadOnlyList<Assembly> userAsms)
        {
            // (1) `TreeNode treeNodeN = new TreeNode(...)` — build the node (children resolve from earlier locals).
            if (stmt is LocalDeclarationStatementSyntax lds
                && LastTypeSegment(lds.Declaration.Type.ToString()) == "TreeNode")
            {
                foreach (var v in lds.Declaration.Variables)
                {
                    treeNodeLocals.Add(v.Identifier.Text);
                    nodeMap[v.Identifier.Text] = v.Initializer?.Value is ObjectCreationExpressionSyntax oce
                        ? BuildTreeNode(oce, nodeMap, userAsms)
                        : new System.Windows.Forms.TreeNode();
                }
                return true;
            }
            if (stmt is not ExpressionStatementSyntax es) return false;

            // (2) `treeNodeN.Prop = value` — a property assignment on a known TreeNode local.
            if (es.Expression is AssignmentExpressionSyntax asg && asg.IsKind(SyntaxKind.SimpleAssignmentExpression))
            {
                var lhs = Flatten(asg.Left);
                if (lhs.Count < 1 || !treeNodeLocals.Contains(lhs[0])) return false;
                // it targets a TreeNode local → treat as a node statement. Apply only the modelled value properties;
                // an unmodelled/nested one is a best-effort skip (still representable — nothing is lost on render).
                if (lhs.Count == 2 && TreeNodeSettableProps.Contains(lhs[1]) && nodeMap.TryGetValue(lhs[0], out var node))
                {
                    var pd = TypeDescriptor.GetProperties(node)[lhs[1]];
                    if (pd != null && !pd.IsReadOnly)
                    {
                        var val = Eval(asg.Right, pd.PropertyType, userAsms);
                        if (val != null) { try { pd.SetValue(node, val); } catch { /* value not applicable — skip */ } }
                    }
                }
                return true;
            }

            // (3) `owner.Nodes.Add(node)` / `owner.Nodes.AddRange(new TreeNode[]{ … })` — attach to a TreeView or
            // parent TreeNode. The elements must be known TreeNode locals; anything else is left for the general path.
            if (es.Expression is InvocationExpressionSyntax inv
                && inv.Expression is MemberAccessExpressionSyntax ma
                && (ma.Name.Identifier.Text == "Add" || ma.Name.Identifier.Text == "AddRange"))
            {
                var recv = Flatten(ma.Expression);
                if (recv.Count < 2 || recv[^1] != "Nodes") return false;
                System.Windows.Forms.TreeNodeCollection? coll = null;
                if (comps.TryGetValue(recv[0], out var oc) && oc is System.Windows.Forms.TreeView tv) coll = tv.Nodes;
                else if (nodeMap.TryGetValue(recv[0], out var parent)) coll = parent.Nodes;
                if (coll == null) return false;
                var argList = inv.ArgumentList;
                if (argList == null || argList.Arguments.Count != 1) return false;
                var els = ma.Name.Identifier.Text == "AddRange"
                    ? ExtractArrayElements(argList.Arguments[0].Expression)
                    : new[] { argList.Arguments[0].Expression };
                if (els == null) return false;
                var resolved = new List<System.Windows.Forms.TreeNode>();
                foreach (var el in els)
                {
                    var ec = Flatten(el);
                    if (ec.Count == 1 && nodeMap.TryGetValue(ec[0], out var child)) resolved.Add(child);
                    else return false; // unknown element → don't claim the statement (keep it honest)
                }
                foreach (var child in resolved) coll.Add(child);
                return true;
            }
            return false;
        }

        /// <summary>Builds a <see cref="System.Windows.Forms.TreeNode"/> from a <c>new TreeNode(...)</c> expression:
        /// the recognized overloads are <c>()</c>, <c>(text)</c>, <c>(text, TreeNode[])</c>, <c>(text, int, int)</c>,
        /// and <c>(text, int, int, TreeNode[])</c>. Child locals are resolved from <paramref name="nodeMap"/> (they
        /// were declared earlier). Only string/int literals and child references are read — no arbitrary code.</summary>
        private static System.Windows.Forms.TreeNode BuildTreeNode(
            ObjectCreationExpressionSyntax oce,
            Dictionary<string, System.Windows.Forms.TreeNode> nodeMap,
            IReadOnlyList<Assembly> userAsms)
        {
            var node = new System.Windows.Forms.TreeNode();
            var args = oce.ArgumentList?.Arguments;
            if (args == null || args.Value.Count == 0) return node;
            var list = args.Value;
            int i = 0;
            if (Eval(list[0].Expression, typeof(string), userAsms) is string text) { node.Text = text; i = 1; }
            var ints = new List<int>();
            for (; i < list.Count; i++)
            {
                var expr = list[i].Expression;
                var childExprs = ExtractArrayElements(expr);
                if (childExprs != null)
                {
                    foreach (var ce in childExprs)
                    {
                        var cc = Flatten(ce);
                        if (cc.Count == 1 && nodeMap.TryGetValue(cc[0], out var child)) node.Nodes.Add(child);
                    }
                    continue;
                }
                if (Eval(expr, typeof(int), userAsms) is int iv) ints.Add(iv);
            }
            if (ints.Count >= 1) node.ImageIndex = ints[0];
            if (ints.Count >= 2) node.SelectedImageIndex = ints[1];
            return node;
        }

        /// <summary>True when the compound-assignment (<c>+=</c>/<c>-=</c>) LHS resolves to a real event on a known
        /// component or the root form — i.e. it's an event wiring (<c>this.X.Event += …</c>), not a hand-edited
        /// <c>+=</c> on a property. Walks any intermediate property segments to the event's declaring object.</summary>
        private static bool IsEventWiring(AssignmentExpressionSyntax asg, Control root, Dictionary<string, IComponent> comps)
        {
            var chain = Flatten(asg.Left);
            object? owner;
            int evStart;
            if (chain.Count >= 2 && comps.TryGetValue(chain[0], out var c)) { owner = c; evStart = 1; }
            else if (chain.Count == 1) { owner = root; evStart = 0; }
            else return false;
            for (int i = evStart; i < chain.Count - 1 && owner != null; i++)
                owner = TypeDescriptor.GetProperties(owner)[chain[i]]?.GetValue(owner);
            return owner is IComponent oc && TypeDescriptor.GetEvents(oc)[chain[^1]] != null;
        }

        /// <summary>The last dotted segment of a (possibly qualified) type name, e.g.
        /// "System.ComponentModel.Container" → "Container", "SplitContainer" → "SplitContainer".</summary>
        private static string LastTypeSegment(string typeName)
        {
            int dot = typeName.LastIndexOf('.');
            return dot < 0 ? typeName : typeName.Substring(dot + 1);
        }

        private static void HandleAssignment(AssignmentExpressionSyntax asg, IDesignerHost host, Control root,
            Dictionary<string, IComponent> comps, HashSet<string> fieldNames, HashSet<string> containerNames,
            IReadOnlyList<Assembly> userAsms, HashSet<(IComponent, string)> explicitMembers)
        {
            var chain = Flatten(asg.Left);

            // `this.components = new Container()` — the disposal holder real designer files emit. On a design
            // surface the host owns component lifetime, so we don't instantiate it; we just record the field
            // name so a provider ctor (new ToolTip(this.components)) can recognize the arg. Representable
            // (nothing is lost — the host supplies its own container to CreateComponent).
            // Match the ACTUAL System.ComponentModel.Container by exact short name, not any *Container suffix —
            // otherwise real controls like SplitContainer / ToolStripContainer (now offered by the auto-populated
            // toolbox) would be wrongly treated as the disposal holder, never instantiated, and silently
            // dropped from the render/hit-test map.
            if (chain.Count == 1 && fieldNames.Contains(chain[0]) && asg.Right is ObjectCreationExpressionSyntax cc
                && (cc.ArgumentList?.Arguments.Count ?? 0) == 0 && cc.Initializer == null
                && LastTypeSegment(cc.Type.ToString()) == "Container")
            {
                containerNames.Add(chain[0]);
                return;
            }

            if (chain.Count == 1 && fieldNames.Contains(chain[0]) && asg.Right is ObjectCreationExpressionSyntax oc)
            {
                // the designer always emits the parameterless ctor + separate property assignments.
                // constructor arguments or an object initializer are a hand-edit — flag as
                // unrepresentable rather than create the component and silently drop that
                // state, which would otherwise leave RoundTripSafe == true while losing user code.
                // SOLE EXCEPTION: the extender/component-tray ctor `new T(this.components)` — exactly one
                // arg that is the recognized components container. The host supplies its own container to
                // CreateComponent, so the arg carries no state to lose (ToolTip/ErrorProvider/Timer/…).
                int argCount = oc.ArgumentList?.Arguments.Count ?? 0;
                bool containerCtor = argCount == 1 && oc.Initializer == null
                    && IsContainerArg(oc.ArgumentList!.Arguments[0].Expression, containerNames);
                if ((argCount > 0 && !containerCtor) || oc.Initializer != null)
                {
                    throw new InvalidOperationException("non-designer object creation (ctor args / initializer) for " + chain[0]);
                }
                var t = ResolveType(oc.Type.ToString(), userAsms) ?? throw new InvalidOperationException("unresolved type " + oc.Type);
                if (typeof(IComponent).IsAssignableFrom(t))
                {
                    comps[chain[0]] = host.CreateComponent(t, chain[0]);
                }
                return;
            }

            object target;
            int propStart;
            if (chain.Count >= 2 && comps.ContainsKey(chain[0]))
            {
                target = comps[chain[0]];
                propStart = 1;
            }
            else if (chain.Count == 1)
            {
                target = root;
                propStart = 0;
            }
            else
            {
                throw new InvalidOperationException("unrecognized LHS " + asg.Left);
            }

            // record the source-explicit (owner, property) at the granularity the serializer
            // can match (owner = root or a named field; property = first hop after the owner)
            if (target is IComponent ownerComp)
            {
                explicitMembers.Add((ownerComp, chain[propStart]));
            }

            for (int i = propStart; i < chain.Count - 1; i++)
            {
                var pdMid = TypeDescriptor.GetProperties(target)[chain[i]] ?? throw new InvalidOperationException("no property " + chain[i]);
                target = pdMid.GetValue(target)!;
            }

            string propName = chain[^1];
            var pd = TypeDescriptor.GetProperties(target)[propName]
                ?? throw new InvalidOperationException("no property " + propName + " on " + target.GetType().Name);
            // component-reference RHS: `this.<prop> = this.<component>` (a sibling — AcceptButton/CancelButton,
            // DataGridView.DataSource, a control's ContextMenuStrip, …) OR `this.<prop> = this` (the ROOT form itself,
            // e.g. errorProvider1.ContainerControl = this). Assign the live instance the source names. Eval resolves
            // neither (it carries no `comps` and has no ThisExpression case → bare `this` would throw), so intercept
            // both here; the serializer re-emits the reference. A root RHS binds to `root`, which is in scope and is
            // the form instance — SetValue rejects a non-assignable target (kept unrepresentable, as before). Every
            // non-reference RHS (literals, enums, Point/Size, resources.GetObject, …) still goes through Eval unchanged.
            var rhsChain = Flatten(asg.Right);
            object? val = asg.Right is ThisExpressionSyntax
                ? root
                : (rhsChain.Count == 1 && comps.TryGetValue(rhsChain[0], out var refComp))
                    ? refComp
                    : Eval(asg.Right, pd.PropertyType, userAsms);
            pd.SetValue(target, val);
        }

        /// <summary>True when the expression is the recognized components container (<c>this.components</c>
        /// or a bare <c>components</c>) — gates the sole allowed ctor-arg (provider/tray ctors).</summary>
        private static bool IsContainerArg(ExpressionSyntax arg, HashSet<string> containerNames)
        {
            var c = Flatten(arg);
            return c.Count == 1 && containerNames.Contains(c[0]);
        }

        /// <summary>
        /// ISupportInitialize init bracketing: ((System.ComponentModel.ISupportInitialize)(this.x)).BeginInit()/.EndInit()
        /// — designer-managed init scaffolding VS emits around any DataGridView/BindingSource/PictureBox/NumericUpDown/
        /// SplitContainer. A representable no-op for RENDER; captured verbatim so the serializer re-emits it on a
        /// round-trip (0.12.0 R1). Matched by the FULLY-QUALIFIED System.ComponentModel.ISupportInitialize so an
        /// unrelated user interface that merely shares the short name isn't silently swallowed as scaffolding.
        /// </summary>
        private static bool IsSupportInitBracket(InvocationExpressionSyntax inv) =>
            inv.Expression is MemberAccessExpressionSyntax ma
            && ma.Name.Identifier.Text is "BeginInit" or "EndInit"
            && ma.Expression is ParenthesizedExpressionSyntax pe && pe.Expression is CastExpressionSyntax ce
            && ce.Type.ToString() == "System.ComponentModel.ISupportInitialize";

        private static bool HandleInvocation(InvocationExpressionSyntax inv, Control root,
            Dictionary<string, IComponent> comps, IReadOnlyList<Assembly> userAsms, out string? why)
        {
            why = null;
            if (inv.Expression is not MemberAccessExpressionSyntax ma)
            {
                why = inv.ToString().Trim();
                return false;
            }
            string method = ma.Name.Identifier.Text;

            if (method is "SuspendLayout" or "ResumeLayout" or "PerformLayout") return true;

            // ISupportInitialize BeginInit/EndInit bracketing — a representable no-op for RENDER (see IsSupportInitBracket).
            // The caller ALSO captures it verbatim into the `supportInit` list so the serializer re-emits it on a
            // round-trip (0.12.0 R1: DesignerSerializer.InjectSupportInit), which is why it now round-trips instead of
            // forcing read-only. Suspend/Resume/PerformLayout above are regenerated canonically by the serializer, so
            // they need no capture.
            if (IsSupportInitBracket(inv))
                return true;

            var targetChain = Flatten(ma.Expression);

            if (method == "Add" && targetChain.Count >= 1 && targetChain[^1] == "Controls")
            {
                Control parent;
                if (targetChain.Count == 1) parent = root;
                else if (comps.TryGetValue(targetChain[0], out var pc) && pc is Control)
                {
                    // walk intermediate property segments between the component and the trailing "Controls" so a
                    // child added to a sub-container exposed as a PROPERTY lands in the right place — e.g.
                    // splitContainer1.Panel1.Controls.Add(child) must parent into Panel1 (a SplitterPanel), not the
                    // SplitContainer itself (which rejects a direct Controls.Add). With no intermediate segments
                    // (panel1.Controls.Add) the loop is a no-op and the owner is just the resolved component.
                    object? owner = pc;
                    for (int i = 1; i < targetChain.Count - 1 && owner != null; i++)
                        owner = TypeDescriptor.GetProperties(owner)[targetChain[i]]?.GetValue(owner);
                    if (owner is Control opctl) parent = opctl;
                    else { why = "Controls.Add on unresolved parent: " + ma.Expression; return false; }
                }
                else { why = "Controls.Add on unknown parent: " + ma.Expression; return false; }

                var addArgs = inv.ArgumentList.Arguments;
                if (addArgs.Count == 0) { why = "Controls.Add with no arguments: " + inv.ToString().Trim(); return false; }
                var argChain = Flatten(addArgs[0].Expression);
                if (argChain.Count == 1 && comps.TryGetValue(argChain[0], out var child) && child is Control cctl)
                {
                    // a normal Controls.Add takes ONE arg; only a TableLayoutPanel uses the 3-arg cell overload
                    // Controls.Add(child, column, row). Anything else (extra args, or 3-arg Add to a non-TLP) is
                    // malformed/unsupported → unrepresentable rather than silently dropping the extra args.
                    bool tlpCell = addArgs.Count == 3 && parent is System.Windows.Forms.TableLayoutPanel;
                    if (addArgs.Count != 1 && !tlpCell)
                    {
                        why = "Controls.Add unexpected arg count (" + addArgs.Count + "): " + inv.ToString().Trim();
                        return false;
                    }
                    parent.Controls.Add(cctl);
                    // honor the TLP cell so the child lands where it was designed (a plain Add would auto-flow it,
                    // piling children into the first cells). Column/row are int literals (Eval with an int target).
                    if (tlpCell)
                    {
                        var tlp = (System.Windows.Forms.TableLayoutPanel)parent;
                        if (Eval(addArgs[1].Expression, typeof(int), userAsms) is int col) tlp.SetColumn(cctl, col);
                        if (Eval(addArgs[2].Expression, typeof(int), userAsms) is int row) tlp.SetRow(cctl, row);
                    }
                    return true;
                }
                why = "Controls.Add unknown child: " + inv.ArgumentList.Arguments[0];
                return false;
            }

            // collection single-add: <owner>.<…>.<CollectionProp>.Add(<element>) — the .Add counterpart of the
            // AddRange path below. <element> is either a named component (this.fileMenuItem) or an inline value
            // built via Eval (gated by IsConstructionAllowed). Chief use: TableLayoutPanel.ColumnStyles /
            // RowStyles.Add(new ColumnStyle/RowStyle(SizeType.X, n)) → applies the designed column/row sizing so
            // the grid renders with the right proportions instead of equal-sized cells. (Controls.Add is handled
            // above and returns; a single .Add on any other resolvable IList property lands here.)
            if (method == "Add" && (inv.ArgumentList?.Arguments.Count ?? 0) == 1
                && targetChain.Count >= 2 && targetChain[^1] != "Controls")
            {
                object? coll;
                int cStart;
                if (comps.TryGetValue(targetChain[0], out var owner)) { coll = owner; cStart = 1; }
                else { coll = root; cStart = 0; }
                for (int i = cStart; i < targetChain.Count && coll != null; i++)
                {
                    var pdc = TypeDescriptor.GetProperties(coll)[targetChain[i]];
                    if (pdc == null) { coll = null; break; }
                    coll = pdc.GetValue(coll);
                }
                if (coll is System.Collections.IList clist)
                {
                    var argExpr = inv.ArgumentList!.Arguments[0].Expression;
                    var elChain = Flatten(argExpr);
                    object? elem = (elChain.Count == 1 && comps.TryGetValue(elChain[0], out var item))
                        ? item                                   // named component (mirrors the AddRange path)
                        : Eval(argExpr, null, userAsms);         // inline value — IsConstructionAllowed-gated
                    if (elem != null) { clist.Add(elem); return true; }
                }
                why = "collection Add: unsupported " + inv.ToString().Trim();
                return false;
            }

            // collection population: <owner>.<…>.<CollectionProp>.AddRange(new T[]{ a, b, … }) — menu/toolstrip
            // Items, ListView Columns, etc. The elements were created earlier via `new`; resolve the collection
            // by walking the property chain, then add each referenced component (IList.Add accepts them). This
            // improves render fidelity (the items/columns actually appear) AND representability (these were
            // previously unrepresentable → read-only fallback).
            if (method == "AddRange" && (inv.ArgumentList?.Arguments.Count ?? 0) == 1)
            {
                object? coll;
                int cStart;
                if (comps.TryGetValue(targetChain[0], out var owner)) { coll = owner; cStart = 1; }
                else { coll = root; cStart = 0; }
                for (int i = cStart; i < targetChain.Count && coll != null; i++)
                {
                    var pdc = TypeDescriptor.GetProperties(coll)[targetChain[i]];
                    if (pdc == null) { why = "AddRange: no property " + targetChain[i]; return false; }
                    coll = pdc.GetValue(coll);
                }
                var elems = ExtractArrayElements(inv.ArgumentList!.Arguments[0].Expression);
                if (coll is System.Collections.IList list && elems != null)
                {
                    foreach (var elExpr in elems)
                    {
                        var elChain = Flatten(elExpr);
                        if (elChain.Count == 1 && comps.TryGetValue(elChain[0], out var item)) list.Add(item);
                        else
                        {
                            // inline value element — e.g. ComboBox/ListBox.Items.AddRange(new object[]{ "Alpha", … }).
                            // Eval is IsConstructionAllowed-gated (no side-effecting ctors); a string/number literal
                            // just materializes. Makes string-item collections actually populate (ListBox shows its
                            // items) AND representable instead of dropping the whole AddRange to read-only.
                            var v = Eval(elExpr, null, userAsms);
                            if (v != null) list.Add(v);
                            else { why = "AddRange: unknown element " + elExpr; return false; }
                        }
                    }
                    return true;
                }
                why = "AddRange: unsupported collection/arg " + ma.Expression;
                return false;
            }

            // extender provider: <provider>.Set<X>(<target>, <value>) sets an extended property the provider
            // adds to <target> (ToolTip.SetToolTip, ErrorProvider.SetError/SetIconAlignment, …). Gated on
            // IExtenderProvider + a resolved component target. Makes these representable AND renders their
            // effect (e.g. the ErrorProvider error glyph) instead of dropping them to read-only.
            if (method.StartsWith("Set", StringComparison.Ordinal) && targetChain.Count == 1
                && comps.TryGetValue(targetChain[0], out var prov) && prov is System.ComponentModel.IExtenderProvider
                && (inv.ArgumentList?.Arguments.Count ?? 0) == 2)
            {
                var tgtChain = Flatten(inv.ArgumentList!.Arguments[0].Expression);
                if (tgtChain.Count == 1 && comps.TryGetValue(tgtChain[0], out var target))
                {
                    var setM = prov.GetType().GetMethod(method, BindingFlags.Public | BindingFlags.Instance);
                    if (setM != null && setM.GetParameters().Length == 2)
                    {
                        object? value = Eval(inv.ArgumentList.Arguments[1].Expression, setM.GetParameters()[1].ParameterType, userAsms);
                        setM.Invoke(prov, new object?[] { target, value });
                        return true;
                    }
                }
                why = "extender Set: unresolved target/method for " + inv.ToString().Trim();
                return false;
            }

            why = inv.ToString().Trim();
            return false;
        }

        /// <summary>The element expressions of an array argument (<c>new T[]{a,b}</c> / <c>new[]{a,b}</c> /
        /// bare <c>{a,b}</c>), or null if it isn't an array initializer.</summary>
        private static IReadOnlyList<ExpressionSyntax>? ExtractArrayElements(ExpressionSyntax arg)
        {
            InitializerExpressionSyntax? init = arg switch
            {
                ArrayCreationExpressionSyntax ac => ac.Initializer,
                ImplicitArrayCreationExpressionSyntax iac => iac.Initializer,
                InitializerExpressionSyntax ie => ie,
                _ => null,
            };
            return init?.Expressions.ToList();
        }

        private static object? Eval(ExpressionSyntax expr, Type? targetType, IReadOnlyList<Assembly> userAsms)
        {
            switch (expr)
            {
                case LiteralExpressionSyntax lit:
                    if (lit.IsKind(SyntaxKind.TrueLiteralExpression)) return true;
                    if (lit.IsKind(SyntaxKind.FalseLiteralExpression)) return false;
                    if (lit.IsKind(SyntaxKind.NullLiteralExpression)) return null;
                    if (lit.IsKind(SyntaxKind.StringLiteralExpression)) return lit.Token.Value;
                    {
                        object? v = lit.Token.Value;
                        if (targetType != null && v is IConvertible && targetType != typeof(object))
                        {
                            try { return Convert.ChangeType(v, Nullable.GetUnderlyingType(targetType) ?? targetType); }
                            catch { return v; }
                        }
                        return v;
                    }

                case PrefixUnaryExpressionSyntax u when u.IsKind(SyntaxKind.UnaryMinusExpression):
                    {
                        // Negate in the operand's OWN type (Eval already coerced the inner literal to targetType).
                        // The old int/double/long-only ladder returned every OTHER numeric literal UNNEGATED and
                        // without complaint: `numericUpDown1.Minimum = -100` (decimal) rendered and described as
                        // 100, and `new SizeF(-6F, -13F)` lost both signs — a wrong value shown as fact. Anything we
                        // cannot negate now THROWS, so it surfaces as `unrepresentable` (banner + read-only) rather
                        // than a plausible wrong number.
                        object? inner = Eval(u.Operand, targetType, userAsms);
                        return inner switch
                        {
                            int i => -i,
                            long l => -l,
                            double d => -d,
                            float f => -f,
                            decimal m => -m,
                            short s => (short)-s,
                            sbyte sb => (sbyte)-sb,
                            _ => throw new InvalidOperationException(
                                "cannot negate literal of type " + (inner?.GetType().FullName ?? "null")),
                        };
                    }

                case ObjectCreationExpressionSyntax oc:
                    {
                        var t = ResolveType(oc.Type.ToString(), userAsms) ?? throw new InvalidOperationException("unresolved type " + oc.Type);
                        // SECURITY: Activator.CreateInstance on any resolvable type would run a side-effecting
                        // constructor on open/render (ResolveType reaches corelib, so e.g.
                        // new System.IO.FileStream(path, FileMode.Create) creates/truncates a real file; a user
                        // DLL's `new Evil.Detonator()` would detonate). The designer only legitimately constructs
                        // a small set of side-effect-free drawing/forms value initializers as property values —
                        // restrict to exactly those (see AllowedConstructionTypes), so no corelib/BCL/user
                        // constructor is executable from a .Designer.cs.
                        if (!IsConstructionAllowed(t))
                        {
                            throw new InvalidOperationException("construction not allowed: " + t.FullName);
                        }
                        var args = oc.ArgumentList?.Arguments.Select(a => Eval(a.Expression, null, userAsms)).ToArray() ?? Array.Empty<object?>();
                        return Activator.CreateInstance(t, args);
                    }

                case MemberAccessExpressionSyntax ma:
                    {
                        string member = ma.Name.Identifier.Text;
                        var t = ResolveType(ma.Expression.ToString(), userAsms);
                        if (t != null)
                        {
                            if (t.IsEnum) return Enum.Parse(t, member);
                            // SECURITY: reading a public static property/field invokes its getter. Restrict to the
                            // pure, side-effect-free framework value sources the designer/value-converter emit
                            // (Color.Red, SystemColors.Control, Size.Empty, …). Otherwise a getter newly reachable
                            // via Drawing.Common (System.Drawing.SystemFonts/SystemIcons/Brushes/Pens), a corelib
                            // getter (System.Environment.MachineName — a pre-existing info leak), or a user DLL's
                            // side-effecting static getter would run on open. Anything else stays unrepresentable.
                            if (IsStaticReadAllowed(t))
                            {
                                var p = t.GetProperty(member, BindingFlags.Public | BindingFlags.Static);
                                if (p != null) return p.GetValue(null);
                                var fi = t.GetField(member, BindingFlags.Public | BindingFlags.Static);
                                if (fi != null) return fi.GetValue(null);
                            }
                        }
                        if (targetType != null && targetType.IsEnum) return Enum.Parse(targetType, member);
                        throw new InvalidOperationException("cannot evaluate member access " + ma);
                    }

                case InvocationExpressionSyntax invk when invk.Expression is MemberAccessExpressionSyntax mai:
                    {
                        // resx lookup: `resources.GetObject("comp.Prop")` / `resources.GetString("...")` — resolve
                        // against the form's .resx (safe, type-allowlisted reader). Checked BEFORE type resolution
                        // because `resources` is a LOCAL variable, not a type (ResolveType would fail). Returns null
                        // for a missing/unsafe/absent-resx entry → the property stays unset, form still renders.
                        if (_resx is { } rx && rx.resolver != null
                            && mai.Expression is IdentifierNameSyntax rid && rx.vars.Contains(rid.Identifier.Text)
                            && (mai.Name.Identifier.Text is "GetObject" or "GetString")
                            && invk.ArgumentList.Arguments.Count == 1
                            && invk.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax rlit
                            && rlit.IsKind(SyntaxKind.StringLiteralExpression))
                        {
                            string key = rlit.Token.ValueText;
                            return mai.Name.Identifier.Text == "GetString" ? rx.resolver.GetString(key) : rx.resolver.GetObject(key);
                        }

                        // static factory call: Type.Method(args) — e.g. System.Drawing.Color.FromArgb(64, 128, 255),
                        // which the value-converter emits for non-named colors and real VS designer files contain.
                        var t = ResolveType(mai.Expression.ToString(), userAsms)
                                ?? throw new InvalidOperationException("cannot evaluate invocation (unresolved type) " + invk);
                        string methodName = mai.Name.Identifier.Text;
                        // SECURITY: invoking an arbitrary static method on any resolvable type would let a
                        // hand-crafted .Designer.cs run code on open/render. An assembly-wide grant is still
                        // too broad — e.g. System.Windows.Forms.MessageBox.Show or System.Drawing.Image.FromFile
                        // would resolve and execute. Allow only the exact, side-effect-free Color factory methods
                        // the value-converter emits (the gate is checked before args are evaluated, and every
                        // nested invocation re-enters this same gate, so dangerous calls cannot slip in as args).
                        if (!IsFactoryInvocationAllowed(t, methodName))
                        {
                            throw new InvalidOperationException("invocation not allowed: " + t.FullName + "." + methodName);
                        }
                        var args = invk.ArgumentList.Arguments.Select(a => Eval(a.Expression, null, userAsms)).ToArray();
                        var mi = FindStaticMethod(t, methodName, args)
                                 ?? throw new InvalidOperationException("no matching static method " + t.Name + "." + methodName + "(" + args.Length + " args)");
                        var ps = mi.GetParameters();
                        var call = new object?[args.Length];
                        for (int i = 0; i < args.Length; i++) call[i] = CoerceArg(args[i], ps[i].ParameterType);
                        return mi.Invoke(null, call);
                    }

                case IdentifierNameSyntax id when targetType != null && targetType.IsEnum:
                    return Enum.Parse(targetType, id.Identifier.Text);

                case ParenthesizedExpressionSyntax paren:
                    return Eval(paren.Expression, targetType, userAsms);

                case CastExpressionSyntax cast:
                    {
                        // a cast in a designer expression is a pure value conversion, not code execution
                        // (e.g. the ((byte)(204)) gdiCharSet arg real designer files put in a Font ctor).
                        // Evaluate the operand and convert to the cast's target type — no construction or
                        // invocation involved, so it needs no security gate.
                        Type? ct = ResolveCastType(cast.Type, userAsms);
                        object? inner = Eval(cast.Expression, ct, userAsms);
                        if (ct == null || inner == null) return inner;
                        if (ct.IsEnum && inner is IConvertible) return Enum.ToObject(ct, inner);
                        if (inner is IConvertible) { try { return Convert.ChangeType(inner, Nullable.GetUnderlyingType(ct) ?? ct); } catch { return inner; } }
                        return inner;
                    }

                case BinaryExpressionSyntax be when be.IsKind(SyntaxKind.BitwiseOrExpression):
                    {
                        // combined enum flags: AnchorStyles.Top | AnchorStyles.Left (targetType known), or
                        // FontStyle.Bold | FontStyle.Italic passed as a ctor arg (targetType null — inferred
                        // from the evaluated operands' runtime enum type).
                        object? l = Eval(be.Left, targetType, userAsms);
                        object? r = Eval(be.Right, targetType, userAsms);
                        Type? et = targetType is { IsEnum: true } ? targetType
                                 : l?.GetType() is { IsEnum: true } lt ? lt
                                 : r?.GetType() is { IsEnum: true } rt ? rt
                                 : null;
                        if (et != null)
                        {
                            long acc = Convert.ToInt64(l) | Convert.ToInt64(r);
                            return Enum.ToObject(et, acc);
                        }
                        throw new InvalidOperationException("unsupported bitwise-or operands: " + be);
                    }

                case ArrayCreationExpressionSyntax arr:
                    return EvalArray(arr.Type.ElementType, arr.Initializer, targetType, userAsms);

                case ImplicitArrayCreationExpressionSyntax iarr:
                    return EvalArray(null, iarr.Initializer, targetType, userAsms);

                default:
                    throw new InvalidOperationException("unsupported expression: " + expr.Kind() + " '" + expr + "'");
            }
        }

        /// <summary>Evaluate an array-creation expression (<c>new string[] { "a", "b" }</c>, <c>new string[] { }</c>,
        /// <c>new string[0]</c>, or the implicit <c>new[] { … }</c>) to a live array. Emitted by the string[] property
        /// editor (TextBox/RichTextBox.Lines) and present in hand-written designer files. SECURITY: the element type
        /// is restricted to string + primitives — <see cref="Array.CreateInstance(Type,int)"/> runs no constructor and
        /// every element re-enters the gated <see cref="Eval"/>, so no user ctor/getter is reachable; an unrestricted
        /// element type (<c>new SomeUserType[]{…}</c>) would widen the reachable surface, so it stays unrepresentable.
        /// A sized-but-uninitialized array (<c>new string[5]</c>) yields an empty array — the editor only ever emits an
        /// explicit initializer, and the read side rejects non-initializer RHS.</summary>
        private static object? EvalArray(TypeSyntax? elementTypeSyntax, InitializerExpressionSyntax? initializer,
                                         Type? targetType, IReadOnlyList<Assembly> userAsms)
        {
            Type elem = typeof(string);
            if (elementTypeSyntax != null)
            {
                elem = ResolveCastType(elementTypeSyntax, userAsms)
                    ?? throw new InvalidOperationException("unsupported array element type: " + elementTypeSyntax);
            }
            else if (targetType is { IsArray: true } && targetType.GetElementType() is { } inferred)
            {
                elem = inferred;
            }
            if (!(elem == typeof(string) || elem.IsPrimitive))
            {
                throw new InvalidOperationException("unsupported array element type: " + (elem.FullName ?? elem.Name));
            }
            int n = initializer?.Expressions.Count ?? 0;
            Array result = Array.CreateInstance(elem, n);
            for (int i = 0; i < n; i++)
            {
                result.SetValue(CoerceArg(Eval(initializer!.Expressions[i], elem, userAsms), elem), i);
            }
            return result;
        }

        /// <summary>
        /// Find a public static method by name whose parameter count matches and whose parameters
        /// each accept the evaluated argument (assignable, or a primitive convertible). Selecting by
        /// arity is enough to disambiguate the overloads we emit (e.g. Color.FromArgb's 3- vs 4-int forms).
        /// </summary>
        private static MethodInfo? FindStaticMethod(Type t, string name, object?[] args)
        {
            foreach (var m in t.GetMethods(BindingFlags.Public | BindingFlags.Static))
            {
                if (m.Name != name) continue;
                var ps = m.GetParameters();
                if (ps.Length != args.Length) continue;
                bool ok = true;
                for (int i = 0; i < ps.Length; i++)
                {
                    var pt = ps[i].ParameterType;
                    if (args[i] == null)
                    {
                        // null only fits a reference type or Nullable<T>
                        if (pt.IsValueType && Nullable.GetUnderlyingType(pt) == null) { ok = false; break; }
                        continue;
                    }
                    if (pt.IsInstanceOfType(args[i])) continue;
                    if (args[i] is IConvertible && (pt.IsPrimitive || pt == typeof(decimal))) continue;
                    ok = false;
                    break;
                }
                if (ok) return m;
            }
            return null;
        }

        /// <summary>
        /// The three interpreter security allowlists moved to the shared DesignerAllowlists so the
        /// net10 interpreter, the net48 live-source parser, and the net48 executor gate against ONE set. These thin
        /// forwarders keep the existing Eval call sites (and the pinned SecurityAndResolverTests) working unchanged;
        /// the authoritative sets + their full rationale now live in DesignerAllowlists.cs.
        internal static bool IsFactoryInvocationAllowed(Type t, string methodName) =>
            DesignerAllowlists.IsFactoryInvocationAllowed(t, methodName);

        internal static bool IsConstructionAllowed(Type t) => DesignerAllowlists.IsConstructionAllowed(t);

        internal static bool IsStaticReadAllowed(Type t) => DesignerAllowlists.IsStaticReadAllowed(t);

        private static object? CoerceArg(object? v, Type target)
        {
            if (v == null) return null;
            if (target.IsInstanceOfType(v)) return v;
            try { return Convert.ChangeType(v, Nullable.GetUnderlyingType(target) ?? target); }
            catch { return v; }
        }

        /// <summary>Resolve the target type of a cast: a predefined keyword (byte/int/…) or a named type.</summary>
        private static Type? ResolveCastType(TypeSyntax type, IReadOnlyList<Assembly> userAsms)
        {
            if (type is PredefinedTypeSyntax p)
            {
                return p.Keyword.Kind() switch
                {
                    SyntaxKind.ByteKeyword => typeof(byte),
                    SyntaxKind.SByteKeyword => typeof(sbyte),
                    SyntaxKind.ShortKeyword => typeof(short),
                    SyntaxKind.UShortKeyword => typeof(ushort),
                    SyntaxKind.IntKeyword => typeof(int),
                    SyntaxKind.UIntKeyword => typeof(uint),
                    SyntaxKind.LongKeyword => typeof(long),
                    SyntaxKind.ULongKeyword => typeof(ulong),
                    SyntaxKind.FloatKeyword => typeof(float),
                    SyntaxKind.DoubleKeyword => typeof(double),
                    SyntaxKind.DecimalKeyword => typeof(decimal),
                    SyntaxKind.CharKeyword => typeof(char),
                    SyntaxKind.BoolKeyword => typeof(bool),
                    SyntaxKind.StringKeyword => typeof(string),
                    SyntaxKind.ObjectKeyword => typeof(object),
                    _ => null,
                };
            }
            return ResolveType(type.ToString(), userAsms);
        }

        private static Type? ResolveType(string fullName, IReadOnlyList<Assembly> userAsms)
        {
            Type? t;
            foreach (var asm in userAsms)
            {
                t = asm.GetType(fullName);
                if (t != null) return t;
            }
            t = Type.GetType(fullName);
            if (t != null) return t;
            foreach (var asm in ProbeAssemblies)
            {
                t = asm.GetType(fullName);
                if (t != null) return t;
            }
            return null;
        }

        private static List<string> Flatten(ExpressionSyntax expr)
        {
            var names = new List<string>();
            void Walk(ExpressionSyntax e)
            {
                switch (e)
                {
                    case MemberAccessExpressionSyntax m: Walk(m.Expression); names.Add(m.Name.Identifier.Text); break;
                    case ThisExpressionSyntax: break;
                    case IdentifierNameSyntax id: names.Add(id.Identifier.Text); break;
                    case ParenthesizedExpressionSyntax p: Walk(p.Expression); break;
                    default: names.Add("?" + e.Kind()); break;
                }
            }
            Walk(expr);
            return names;
        }
    }
}
