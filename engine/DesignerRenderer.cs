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
using System.Runtime.CompilerServices;
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

    /// <summary>
    /// Revision-bound result of applying one proven <c>Text</c> source edit to the live modern design surface retained
    /// by <see cref="DesignerRenderer.RenderWithLayout"/>. This is the modern equivalent of Visual Studio keeping its
    /// designer host alive between property-grid edits: layout, pixels, property metadata and geometry authority all
    /// come from the same post-edit graph. <see cref="Applied"/> is false on every token/source/proof mismatch, so the
    /// extension can fall back to the established rebuild path without trusting client-authored cache state.
    /// </summary>
    public sealed class CachedTextPropertyEditResult
    {
        public bool Applied { get; init; }
        public string Reason { get; init; } = "";
        public string GraphToken { get; init; } = "";
        public bool FullFrame { get; init; }
        public bool LayoutUnchanged { get; init; }
        public byte[] Png { get; init; } = Array.Empty<byte>();
        public int X { get; init; }
        public int Y { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
        public int FrameWidth { get; init; }
        public int FrameHeight { get; init; }
        public int ClientWidth { get; init; }
        public int ClientHeight { get; init; }
        public List<LayoutControl> Controls { get; init; } = new();
        public List<ToolStripItemBounds> ToolStripItems { get; init; } = new();
        public ComponentInfo? Component { get; init; }
        public GeometryDragStartResult? Geometry { get; init; }
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
            PrepareForDesignSurfaceCapture(root);
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
                    OverlayProgressBarState(root, big);
                    using var msb = new MemoryStream();
                    big.Save(msb, ImageFormat.Png);
                    return msb.ToArray();
                }
                finally { root.Scale(new SizeF(1f / scale, 1f / scale)); }
            }
            using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            root.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
            OverlayProgressBarState(root, bmp);
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            return ms.ToArray();
        }

        /// <summary>The live Visual Studio designer does not hand keyboard focus to a child merely because it is the
        /// first control in tab order. A hidden render host can do exactly that when its window is created, causing a
        /// TextBox to paint selected text into the preview. Clear transient focus/selection state before every capture;
        /// this changes no serialized property and keeps the image aligned with the design surface.</summary>
        private static void PrepareForDesignSurfaceCapture(Control root)
        {
            if (root.FindForm() is Form form) form.ActiveControl = null;
            foreach (var textBox in DescendantControls(root).OfType<TextBoxBase>())
            {
                textBox.Select(0, 0);
            }
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

            IComponent? target = FindGraphComponent(g, componentId);
            if (target is not Control ctrl)
            {
                return new ControlRenderResult { Found = false };
            }

            return CaptureControlPng(ctrl, root);
        }

        private static ControlRenderResult CaptureControlPng(Control ctrl, Control root, int scale = 1)
        {
            int w = Math.Max(ctrl.Width, 1);
            int h = Math.Max(ctrl.Height, 1);
            // Placement and dimensions stay in logical form pixels. The webview composites this patch into its scaled
            // backing store using the current physical/logical ratio, exactly as it does for the full-frame PNG.
            var (x, y) = ComputeWindowOffset(ctrl, root);
            PrepareForDesignSurfaceCapture(root);
            if (scale > 1)
            {
                // Retained dirty patches are restricted to a geometry-stable leaf. Scaling the entire 300-control
                // root just to repaint this one leaf is O(N) and defeats the dirty-region budget; scale only the
                // invalidated control, then restore its exact logical bounds.
                Rectangle logicalBounds = ctrl.Bounds;
                Padding logicalMargin = ctrl.Margin;
                Padding logicalPadding = ctrl.Padding;
                Size logicalMinimumSize = ctrl.MinimumSize;
                Size logicalMaximumSize = ctrl.MaximumSize;
                Font logicalFont = ctrl.Font;
                ctrl.Scale(new SizeF(scale, scale));
                try
                {
                    using var scaled = new Bitmap(w * scale, h * scale, PixelFormat.Format32bppArgb);
                    ctrl.DrawToBitmap(scaled, new Rectangle(0, 0, w * scale, h * scale));
                    OverlayProgressBarState(ctrl, scaled);
                    using var scaledStream = new MemoryStream();
                    scaled.Save(scaledStream, ImageFormat.Png);
                    return new ControlRenderResult
                    {
                        Png = scaledStream.ToArray(), X = x, Y = y, Width = w, Height = h, Found = true,
                    };
                }
                finally
                {
                    ctrl.Bounds = logicalBounds;
                    ctrl.Margin = logicalMargin;
                    ctrl.Padding = logicalPadding;
                    ctrl.MinimumSize = logicalMinimumSize;
                    ctrl.MaximumSize = logicalMaximumSize;
                    if (!ReferenceEquals(ctrl.Font, logicalFont)) ctrl.Font = logicalFont;
                }
            }
            using var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            ctrl.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
            OverlayProgressBarState(ctrl, bmp);
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);

            // Placement in the FULL-FRAME (window) pixel space, so the host draws the patch directly at
            // (X,Y) over the cached full frame — see ComputeWindowOffset (shared with DescribeLayout).
            return new ControlRenderResult { Png = ms.ToArray(), X = x, Y = y, Width = w, Height = h, Found = true };
        }

        /// <summary>
        /// Native ProgressBar state is not included by WinForms DrawToBitmap/WM_PRINT: a Value=90 bar can otherwise be
        /// byte-identical to Value=0 even though the live component is correct. Paint the themed bar and its bounded
        /// value chunk over the captured rectangle. This is deterministic, applies to full-frame and dirty-region
        /// captures, and leaves every other native/custom control on its real DrawToBitmap path.
        /// </summary>
        private static void OverlayProgressBarState(Control captureRoot, Bitmap bitmap)
        {
            using var graphics = Graphics.FromImage(bitmap);
            foreach (var progress in DescendantControls(captureRoot).OfType<ProgressBar>())
            {
                var (x, y) = ReferenceEquals(progress, captureRoot) ? (0, 0) : ComputeWindowOffset(progress, captureRoot);
                var bounds = Rectangle.Intersect(new Rectangle(x, y, Math.Max(progress.Width, 1), Math.Max(progress.Height, 1)),
                    new Rectangle(0, 0, bitmap.Width, bitmap.Height));
                if (bounds.Width <= 0 || bounds.Height <= 0) continue;

                int range = Math.Max(1, progress.Maximum - progress.Minimum);
                double ratio = Math.Clamp((progress.Value - progress.Minimum) / (double)range, 0d, 1d);
                try
                {
                    if (ProgressBarRenderer.IsSupported)
                    {
                        ProgressBarRenderer.DrawHorizontalBar(graphics, bounds);
                        if (progress.Style != ProgressBarStyle.Marquee && ratio > 0)
                        {
                            var inner = Rectangle.Inflate(bounds, -3, -3);
                            inner.Width = Math.Max(0, (int)Math.Round(inner.Width * ratio));
                            if (inner.Width > 0 && inner.Height > 0)
                                ProgressBarRenderer.DrawHorizontalChunks(graphics, inner);
                        }
                        continue;
                    }
                }
                catch (InvalidOperationException)
                {
                    // Visual styles may become unavailable between IsSupported and drawing; use the classic fallback.
                }

                graphics.FillRectangle(SystemBrushes.Control, bounds);
                ControlPaint.DrawBorder3D(graphics, bounds, Border3DStyle.SunkenOuter);
                if (progress.Style != ProgressBarStyle.Marquee && ratio > 0)
                {
                    var inner = Rectangle.Inflate(bounds, -2, -2);
                    inner.Width = Math.Max(0, (int)Math.Round(inner.Width * ratio));
                    if (inner.Width > 0 && inner.Height > 0) graphics.FillRectangle(SystemBrushes.Highlight, inner);
                }
            }
        }

        private static IEnumerable<Control> DescendantControls(Control root)
        {
            yield return root;
            foreach (Control child in root.Controls)
                foreach (var descendant in DescendantControls(child))
                    yield return descendant;
        }

        /// <summary>
        /// Top-left of a control in the FULL-FRAME (window) pixel space of the chrome-inclusive render —
        /// the single source of truth for BOTH the dirty-region patch placement (<see cref="RenderControl"/>)
        /// and the hit-test rectangles (<see cref="DescribeLayout"/>), so a click maps to exactly the area
        /// a patch would repaint. Root → (0,0); otherwise the sum of each ancestor's offset up to the root
        /// plus the form's client origin within the chrome. The primary path asks WinForms to translate the
        /// child's OUTER Location from its immediate parent's client space into screen space, then subtracts the
        /// root client origin. That preserves every intermediate client inset (GroupBox/Panel/TabPage and custom
        /// container chrome) instead of accumulating Bounds as if every parent had a zero-width border.
        /// </summary>
        private static (int X, int Y) ComputeWindowOffset(Control ctrl, Control root)
        {
            if (ReferenceEquals(ctrl, root)) return (0, 0);
            var (originX, originY) = RootClientOrigin(root);
            try
            {
                root.CreateControl();
                ctrl.Parent?.CreateControl();
                if (ctrl.Parent != null)
                {
                    Rectangle rootClientScreen = PhysicalClientScreenBounds(root);
                    Point outerA = ctrl.Parent.PointToScreen(ctrl.Location);
                    Point outerB = ctrl.Parent.PointToScreen(new Point(ctrl.Right, ctrl.Bottom));
                    int outerX = Math.Min(outerA.X, outerB.X);
                    int outerY = Math.Min(outerA.Y, outerB.Y);
                    return (outerX - rootClientScreen.Left + originX,
                        outerY - rootClientScreen.Top + originY);
                }
            }
            catch { /* unrealized/hostile handle -> retain the bounded hierarchy fallback below */ }

            int x = 0, y = 0;
            for (Control? c = ctrl; c != null && !ReferenceEquals(c, root); c = c.Parent)
            {
                x += c.Left;
                y += c.Top;
            }
            // A Form with RightToLeftLayout uses WS_EX_LAYOUTRTL: WinForms keeps each child's logical Left unchanged,
            // but paints the whole client surface mirrored. Overlay/hit-test/dirty-patch coordinates must describe the
            // painted window, not the serialized logical coordinate, or selection lands on the opposite side.
            if (root is Form form && form.RightToLeft == RightToLeft.Yes && form.RightToLeftLayout)
                x = root.ClientSize.Width - x - ctrl.Width;
            return (x + originX, y + originY);
        }

        private static (int X, int Y) RootClientOrigin(Control root)
        {
            int x = Math.Max(0, (root.Width - root.ClientSize.Width) / 2);
            int y = Math.Max(0, (root.Height - root.ClientSize.Height) - x);
            return (x, y);
        }

        /// <summary>Physical screen rectangle of a client area. Taking both logical corners is essential for
        /// WS_EX_LAYOUTRTL: PointToScreen(Point.Empty) is the physical right edge on a mirrored window.</summary>
        private static Rectangle PhysicalClientScreenBounds(Control control)
        {
            Point a = control.PointToScreen(Point.Empty);
            Point b = control.PointToScreen(new Point(control.ClientSize.Width, control.ClientSize.Height));
            return Rectangle.FromLTRB(Math.Min(a.X, b.X), Math.Min(a.Y, b.Y), Math.Max(a.X, b.X), Math.Max(a.Y, b.Y));
        }

        /// <summary>Exact live client rectangle in full-frame coordinates. PointToScreen is intentionally used only
        /// for metadata reads after the graph has been realized; the fallback is deterministic and never mutates
        /// source when a custom control refuses handle creation.</summary>
        private static Rectangle ComputeClientWindowBounds(Control ctrl, Control root, int outerX, int outerY)
        {
            var (rootOriginX, rootOriginY) = RootClientOrigin(root);
            try
            {
                root.CreateControl();
                ctrl.CreateControl();
                Rectangle rootClientScreen = PhysicalClientScreenBounds(root);
                Rectangle clientScreen = PhysicalClientScreenBounds(ctrl);
                return new Rectangle(
                    clientScreen.Left - rootClientScreen.Left + rootOriginX,
                    clientScreen.Top - rootClientScreen.Top + rootOriginY,
                    Math.Max(ctrl.ClientSize.Width, 1),
                    Math.Max(ctrl.ClientSize.Height, 1));
            }
            catch
            {
                int insetX = Math.Max(0, (ctrl.Width - ctrl.ClientSize.Width) / 2);
                int insetY = Math.Max(0, ctrl.Height - ctrl.ClientSize.Height - insetX);
                return new Rectangle(outerX + insetX, outerY + insetY,
                    Math.Max(ctrl.ClientSize.Width, 1), Math.Max(ctrl.ClientSize.Height, 1));
            }
        }

        /// <summary>Measure the first rendered text baseline for Label, ButtonBase, and TextBoxBase controls from the live Font/DPI and the control's real client
        /// rectangle. The browser only scales this engine-authored logical coordinate by zoom, so font, DPI and zoom
        /// cannot independently invent a different guide.</summary>
        private static int MeasureTextBaseline(Control ctrl, Rectangle clientWindow)
        {
            if (ctrl is not Label && ctrl is not TextBoxBase && ctrl is not ButtonBase) return -1;
            try
            {
                using var graphics = ctrl.CreateGraphics();
                Font font = ctrl.Font;
                int em = font.FontFamily.GetEmHeight(font.Style);
                int ascentDesign = font.FontFamily.GetCellAscent(font.Style);
                float emPixels = font.SizeInPoints * graphics.DpiY / 72f;
                float ascent = em > 0 ? ascentDesign * emPixels / em : font.GetHeight(graphics) * 0.8f;
                float lineHeight = font.GetHeight(graphics);

                Rectangle display = ctrl.DisplayRectangle;
                int top = Math.Max(0, display.Top);
                int available = Math.Max(1, Math.Min(clientWindow.Height - top, display.Height));
                if (ctrl is Label label)
                {
                    bool middle = label.TextAlign is ContentAlignment.MiddleLeft
                        or ContentAlignment.MiddleCenter or ContentAlignment.MiddleRight;
                    bool bottom = label.TextAlign is ContentAlignment.BottomLeft
                        or ContentAlignment.BottomCenter or ContentAlignment.BottomRight;
                    if (bottom) top += Math.Max(0, (int)Math.Floor(available - lineHeight));
                    else if (middle) top += Math.Max(0, (int)Math.Floor((available - lineHeight) / 2f));
                }
                else if (ctrl is ButtonBase button)
                {
                    bool middle = button.TextAlign is ContentAlignment.MiddleLeft
                        or ContentAlignment.MiddleCenter or ContentAlignment.MiddleRight;
                    bool bottom = button.TextAlign is ContentAlignment.BottomLeft
                        or ContentAlignment.BottomCenter or ContentAlignment.BottomRight;
                    if (bottom) top += Math.Max(0, (int)Math.Floor(available - lineHeight));
                    else if (middle) top += Math.Max(0, (int)Math.Floor((available - lineHeight) / 2f));
                }
                else if (ctrl is TextBoxBase textBox && !textBox.Multiline)
                {
                    top += Math.Max(0, (int)Math.Floor((available - lineHeight) / 2f));
                }

                // ButtonBase's themed content rectangle carries one additional vertical text inset relative to the
                // public client rectangle. The actual VS ButtonDesigner exposes that inset in its Baseline SnapLine
                // (default 100x30 Button offset 21, while the raw Font ascent calculation yields 20).
                int themedButtonInset = ctrl is ButtonBase ? 1 : 0;
                int baseline = clientWindow.Y + top + (int)Math.Round(ascent, MidpointRounding.AwayFromZero)
                    + themedButtonInset;
                return Math.Max(clientWindow.Y, Math.Min(clientWindow.Bottom - 1, baseline));
            }
            catch { return -1; }
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
        /// <summary>
        /// Make a plain form localizable — Visual Studio's Localizable = true. Loads the graph so every value comes
        /// from the LIVE component (the same value the preview shows), takes the inventory of localizable properties
        /// the source assigns, and hands it to <see cref="DesignerLocalizeForm"/> to compose the rewritten source
        /// and the neutral .resx. Nothing is written here: the host applies both in one undoable edit.
        /// </summary>
        public static LocalizeFormResult MakeLocalizable(string designerFilePath, string? controlAssemblyPath = null,
            string? sourceText = null, string? resxText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            // A form the interpreter cannot fully represent must not be converted: the conversion reasons about the
            // statements it sees, and an unrepresentable one may carry state this pass would silently strand.
            if (g.Unrepresentable.Count != 0)
                return new LocalizeFormResult { Safe = false, Reason = "the form contains constructs this engine cannot interpret: " + g.Unrepresentable[0] };

            var root = (Control)g.Host.RootComponent;
            var values = new List<LocalizableValue>();
            foreach (var component in g.GraphComponents)
            {
                string id = ReferenceEquals(component, root) ? "this" : (component.Site?.Name ?? "");
                if (id.Length == 0) continue;
                foreach (PropertyDescriptor prop in TypeDescriptor.GetProperties(component))
                {
                    if (!prop.IsLocalizable || prop.IsReadOnly) continue;
                    if (!DesignerLocalizedResxEditor.SupportsScalarType(prop.PropertyType.FullName ?? "")) continue;
                    string? invariant;
                    try
                    {
                        object? value = prop.GetValue(component);
                        if (value == null) continue;
                        invariant = TypeDescriptor.GetConverter(prop.PropertyType).ConvertToInvariantString(value);
                    }
                    catch { continue; } // a property that throws on read is left in code, untouched
                    if (invariant == null) continue;
                    values.Add(new LocalizableValue
                    {
                        ComponentId = id,
                        PropertyName = prop.Name,
                        ValueTypeName = prop.PropertyType.FullName ?? "",
                        InvariantValue = invariant,
                    });
                }
            }
            return DesignerLocalizeForm.Apply(src, g.ClassName, values, resxText);
        }

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
        /// Begin an engine-authoritative direct-manipulation gesture. The returned bounds and editability flags are
        /// read from the live interpreted graph, not inferred by the client from the previous render.
        /// </summary>
        public static GeometryDragStartResult BeginGeometryDrag(string designerFilePath, string componentId, string? controlAssemblyPath = null, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            return BeginGeometryDrag(g, componentId, src);
        }

        private static GeometryDragStartResult BeginGeometryDrag(LoadedGraph g, string componentId, string sourceText)
        {
            var root = (Control)g.Host.RootComponent;
            if (root.Width <= 0 || root.Height <= 0)
            {
                root.ClientSize = new Size(400, 300);
            }

            var owned = g.Ownership.FirstOrDefault(kv => kv.Value.Id == componentId);
            if (owned.Key is Control inheritedControl && owned.Value.Ownership == "inherited"
                && owned.Value.InheritedPropertyOverrideEditable)
                return DesignerGeometry.BeginInherited(inheritedControl, root, g.ClassName, componentId,
                    owned.Value.BaseIdentityToken, WindowBoundsOf(root));
            if (owned.Key != null && !owned.Value.Editable)
                return new GeometryDragStartResult
                {
                    Ok = true,
                    Reason = owned.Value.ReadOnlyReason ?? "Component is read-only.",
                    ComponentId = owned.Value.Id,
                    ComponentType = owned.Key.GetType().FullName ?? owned.Key.GetType().Name,
                    CanMove = false,
                    CanResize = false,
                };

            return DesignerGeometry.Begin(
                g.Host.Container,
                root,
                g.ClassName,
                componentId,
                sourceText,
                g.InheritedBase,
                WindowBoundsOf(root));
        }

        /// <summary>
        /// Validate and commit candidate logical bounds against the live graph without writing files. The engine applies
        /// <see cref="Control.SetBounds(int,int,int,int)"/>, runs layout, reads back corrected bounds, and returns a
        /// safe source-text preview for the authoritative corrected values.
        /// </summary>
        public static GeometryCommitResult CommitGeometryBounds(
            string designerFilePath,
            string componentId,
            int x,
            int y,
            int width,
            int height,
            string? controlAssemblyPath = null,
            string? sourceText = null,
            string? expectedBaseIdentityToken = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            var root = (Control)g.Host.RootComponent;
            if (root.Width <= 0 || root.Height <= 0)
            {
                root.ClientSize = new Size(400, 300);
            }


            var owned = g.Ownership.FirstOrDefault(kv => kv.Value.Id == componentId);
            if (owned.Key is Control inheritedControl && owned.Value.Ownership == "inherited"
                && owned.Value.InheritedPropertyOverrideEditable)
                return DesignerGeometry.CommitInherited(
                    inheritedControl,
                    root,
                    g.ClassName,
                    componentId,
                    new GeometryRect { X = x, Y = y, Width = width, Height = height },
                    src,
                    owned.Value,
                    expectedBaseIdentityToken ?? "",
                    WindowBoundsOf(root));
            if (owned.Key != null && !owned.Value.Editable)
                return new GeometryCommitResult
                {
                    Ok = false,
                    Reason = owned.Value.ReadOnlyReason ?? "Component is read-only.",
                    ComponentId = owned.Value.Id,
                };

            return DesignerGeometry.Commit(
                g.Host.Container,
                root,
                g.ClassName,
                componentId,
                new GeometryRect { X = x, Y = y, Width = width, Height = height },
                src,
                g.InheritedBase,
                WindowBoundsOf(root));
        }

        private static Func<Control, GeometryRect> WindowBoundsOf(Control root) => ctrl =>
        {
            var (wx, wy) = ComputeWindowOffset(ctrl, root);
            return new GeometryRect
            {
                X = ReferenceEquals(ctrl, root) ? 0 : wx,
                Y = ReferenceEquals(ctrl, root) ? 0 : wy,
                Width = ReferenceEquals(ctrl, root) ? Math.Max(root.Width, 1) : Math.Max(ctrl.Width, 1),
                Height = ReferenceEquals(ctrl, root) ? Math.Max(root.Height, 1) : Math.Max(ctrl.Height, 1),
            };
        };

        /// <summary>
        /// Render the full frame to PNG AND build the click-to-select hit-test map from ONE graph load —
        /// the combined <see cref="RenderDetailed"/> + <see cref="DescribeLayout"/> the unified designer's
        /// full render needs together. Issued as two RPCs, render and layout each re-parsed, re-interpreted
        /// and rebuilt the graph (the dominant cost on large forms); folding them halves that work. The
        /// returned Png/Width/Height and Controls are byte/field-identical to the two separate calls.
        /// </summary>
        public static RenderLayoutResult RenderWithLayout(string designerFilePath, string? controlAssemblyPath = null, string? sourceText = null,
            int renderScale = 1, string[]? selectedTabs = null)
        {
            string graphSource = sourceText ?? ReadWithEncoding(designerFilePath).text;
            var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            bool retained = false;
            try
            {
                var root = (Control)g.Host.RootComponent;
                ApplyTabViewState(g, selectedTabs);
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
                var tray = BuildTray(g, root);
                string autoScaleDimensions = SerializedAutoScaleDimensions(root);
                string graphToken = RetainGraph(designerFilePath, graphSource, g, controls, renderScale);
                retained = graphToken.Length > 0;

                return new RenderLayoutResult
                {
                    GraphToken = graphToken,
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
                    Tray = tray,
                    ToolStripItems = toolStripItems,
                    AutoScaleDimensions = autoScaleDimensions,
                };
            }
            finally
            {
                if (!retained) g.Dispose();
            }
        }

        /// <summary>
        /// Apply one ordinary string <c>Text</c> edit to the exact modern graph retained by
        /// <see cref="RenderWithLayout"/>. The token alone grants nothing: path, old source bytes and the independently
        /// recomputed source-first edit must all match before a live setter runs. Any post-set failure evicts the
        /// now-untrusted graph, leaving the caller to rebuild from the already committed source.
        /// </summary>
        public static CachedTextPropertyEditResult ApplyCachedTextPropertyEdit(
            string graphToken,
            string designerFilePath,
            string componentId,
            string propertyName,
            string newValueExpr,
            string beforeSourceText,
            string afterSourceText)
        {
            var entry = FindRetainedGraph(graphToken);
            if (entry == null)
                return CachedTextRefusal("retained graph token is missing or expired");
            if (!string.Equals(entry.DesignerFilePath, CanonicalDesignerPath(designerFilePath), StringComparison.OrdinalIgnoreCase))
                return CachedTextRefusal("retained graph belongs to another designer document");
            if (!string.Equals(entry.SourceText, beforeSourceText, StringComparison.Ordinal))
                return CachedTextRefusal("retained graph source revision does not match the requested edit");
            if (propertyName != "Text")
                return CachedTextRefusal("only the bounded Text fast path is supported");

            // Recompute the established deterministic splice against the exact retained old bytes. Current-source
            // ownership is independently proven from the live graph below, while the ordinary Lane B planner already
            // performed its full minimality gate before the host committed. Re-running ApplyPropertyEdit here would
            // parse the same 300-control file five more times; exact deterministic bytes + syntax is the independent
            // post-commit proof this token-bound path needs.
            var proof = DesignerPropertyEditor.EditProperty(
                beforeSourceText, componentId, propertyName, newValueExpr);
            if (proof.Mode == EditMode.Failed || string.IsNullOrEmpty(proof.NewText)
                || !string.Equals(proof.NewText, afterSourceText, StringComparison.Ordinal))
                return CachedTextRefusal("the independently recomputed source edit does not match the committed bytes");
            if (CSharpSyntaxTree.ParseText(afterSourceText).GetDiagnostics()
                .Any(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error))
                return CachedTextRefusal("the committed source edit contains syntax errors");

            var g = entry.Graph;
            if (g.Unrepresentable.Count != 0)
                return CachedTextRefusal("partial designer graphs are not eligible for retained live edits");
            var owned = g.Ownership.FirstOrDefault(pair => pair.Value.Id == componentId);
            if (owned.Key is not Control target || !owned.Value.Editable || owned.Value.Ownership != "currentSource")
                return CachedTextRefusal("the target is not an editable current-source control");
            var descriptor = TypeDescriptor.GetProperties(target).Find(propertyName, ignoreCase: false);
            if (descriptor == null || descriptor.IsReadOnly || descriptor.PropertyType != typeof(string))
                return CachedTextRefusal("the target Text property is not an editable System.String value");

            try
            {
                var root = (Control)g.Host.RootComponent;
                var beforeGeometry = CapturePatchGeometry(root);
                var expression = SyntaxFactory.ParseExpression(newValueExpr);
                if (expression.ContainsDiagnostics)
                    return CachedTextRefusal("the Text expression is not valid C# syntax");
                descriptor.SetValue(target, Eval(expression, typeof(string), g.UserAsms));
                g.ExplicitMembers.Add((target, propertyName));

                root.PerformLayout();
                int frameWidth = Math.Max(root.Width, 1);
                int frameHeight = Math.Max(root.Height, 1);
                bool fullFrame = target.Controls.Count != 0 || !SamePatchGeometry(beforeGeometry, root);
                var controls = fullFrame
                    ? BuildLayoutControls(g, root, frameWidth, frameHeight)
                    : new List<LayoutControl>();
                ControlRenderResult patch;
                byte[] png;
                if (fullFrame)
                {
                    png = CaptureRootPng(root, frameWidth, frameHeight, entry.RenderScale);
                    patch = new ControlRenderResult
                    {
                        Found = true,
                        X = 0,
                        Y = 0,
                        Width = frameWidth,
                        Height = frameHeight,
                    };
                }
                else
                {
                    patch = CaptureControlPng(target, root, entry.RenderScale);
                    if (!patch.Found) throw new InvalidOperationException("the retained target could not be captured");
                    png = patch.Png;
                }

                var toolStripItems = fullFrame ? BuildToolStripItems(g, root) : new List<ToolStripItemBounds>();
                var modifiers = DesignerModifiers.ParseFieldModifiers(afterSourceText);
                var component = DesignerDescribe.DescribeComponent(
                    g.Host, g.ClassName, g.ExplicitMembers, componentId, g.EventWirings, modifiers,
                    g.GraphComponents, g.Ownership, g.ControlAssemblyPath);
                if (component == null || component.Id != componentId)
                    throw new InvalidOperationException("the retained component metadata no longer resolves the edited target");
                var geometry = BeginGeometryDrag(g, componentId, afterSourceText);

                entry.SourceText = afterSourceText;
                if (fullFrame) entry.Controls = controls;
                entry.Used = ++_retainedGraphUse;
                return new CachedTextPropertyEditResult
                {
                    Applied = true,
                    GraphToken = entry.Token,
                    FullFrame = fullFrame,
                    LayoutUnchanged = !fullFrame,
                    Png = png,
                    X = patch.X,
                    Y = patch.Y,
                    Width = patch.Width,
                    Height = patch.Height,
                    FrameWidth = frameWidth,
                    FrameHeight = frameHeight,
                    ClientWidth = root.ClientSize.Width,
                    ClientHeight = root.ClientSize.Height,
                    Controls = controls,
                    ToolStripItems = toolStripItems,
                    Component = component,
                    Geometry = geometry,
                };
            }
            catch (Exception ex)
            {
                EvictRetainedGraph(graphToken);
                return CachedTextRefusal("retained Text edit failed: " + ex.GetType().Name + ": " + ex.Message);
            }
        }

        private static CachedTextPropertyEditResult CachedTextRefusal(string reason) => new() { Reason = reason };

        private sealed class PatchGeometrySnapshot
        {
            public required Control Control { get; init; }
            public Control? Parent { get; init; }
            public Rectangle Bounds { get; init; }
            public Size ClientSize { get; init; }
            public Padding Margin { get; init; }
            public Padding Padding { get; init; }
            public bool Visible { get; init; }
            public int ChildCount { get; init; }
        }

        private static List<PatchGeometrySnapshot> CapturePatchGeometry(Control root)
            => DescendantControls(root).Select(control => new PatchGeometrySnapshot
            {
                Control = control,
                Parent = control.Parent,
                Bounds = control.Bounds,
                ClientSize = control.ClientSize,
                Margin = control.Margin,
                Padding = control.Padding,
                Visible = control.Visible,
                ChildCount = control.Controls.Count,
            }).ToList();

        private static bool SamePatchGeometry(IReadOnlyList<PatchGeometrySnapshot> before, Control root)
        {
            var after = DescendantControls(root).ToList();
            if (before.Count != after.Count) return false;
            for (int i = 0; i < after.Count; i++)
            {
                Control current = after[i];
                PatchGeometrySnapshot prior = before[i];
                if (!ReferenceEquals(prior.Control, current) || !ReferenceEquals(prior.Parent, current.Parent)
                    || prior.Bounds != current.Bounds || prior.ClientSize != current.ClientSize
                    || prior.Margin != current.Margin || prior.Padding != current.Padding
                    || prior.Visible != current.Visible || prior.ChildCount != current.Controls.Count)
                    return false;
            }
            return true;
        }

        /// <summary>The live root's <c>CurrentAutoScaleDimensions</c> in the designer's own literal form
        /// ("6F, 13F"), or "" when the root is not a <see cref="ContainerControl"/>. This is the value Visual
        /// Studio persists when it first serializes a form, and it depends on the target's default font — which
        /// is why it is read from the rendered instance instead of assumed.</summary>
        private static string SerializedAutoScaleDimensions(Control root)
        {
            if (root is not ContainerControl container) return "";
            var size = container.CurrentAutoScaleDimensions;
            if (size.Width <= 0 || size.Height <= 0) return "";
            return string.Format(System.Globalization.CultureInfo.InvariantCulture, "{0}F, {1}F", size.Width, size.Height);
        }

        /// <summary>Resolve the standard WinForms tab page whose real header contains a window-space point. The
        /// request rebuilds the same source graph as RenderWithLayout, applies its transient selected-tab overrides
        /// first, and returns an identity only for a field-backed TabPage that belongs to the requested TabControl.
        /// Unknown ids, vendor-shaped hosts, stale state, and off-header points are harmless empty hits.</summary>
        public static TabHit HitTestTab(string designerFilePath, string hostId, int winX, int winY,
            string? controlAssemblyPath = null, string? sourceText = null, string[]? selectedTabs = null)
        {
            try
            {
                using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
                var root = (Control)g.Host.RootComponent;
                ApplyTabViewState(g, selectedTabs);
                if (root.Width <= 0 || root.Height <= 0) root.ClientSize = new Size(400, 300);
                root.CreateControl();
                root.PerformLayout();

                if (FindGraphControl(g, hostId) is not TabControl host) return new TabHit();
                host.CreateControl();
                host.PerformLayout();
                var (hostX, hostY) = ComputeWindowOffset(host, root);
                var local = new Point(winX - hostX, winY - hostY);
                for (int i = 0; i < host.TabCount; i++)
                {
                    Rectangle header;
                    try { header = host.GetTabRect(i); }
                    catch { continue; }
                    if (!header.Contains(local)) continue;
                    var page = host.TabPages[i];
                    if (!g.Ownership.TryGetValue(page, out var source)
                        || string.IsNullOrWhiteSpace(source.Id) || source.Id == "this") return new TabHit();
                    return new TabHit { PageId = source.Id, Text = page.Text ?? "" };
                }
            }
            catch { /* malformed graph or handle creation failure -> fail closed */ }
            return new TabHit();
        }

        /// <summary>Confirm one selected control's hosted adorner hover against a freshly loaded product graph. The
        /// canvas supplies only a component id, an engine-issued adorner id, and control-local coordinates; the live
        /// ControlDesigner descriptor and optional hit-test callback must both agree.</summary>
        public static DesignerAdornerHitInfo HitTestDesignerAdorner(
            string designerFilePath,
            string componentId,
            string adornerId,
            int localX,
            int localY,
            string? controlAssemblyPath = null,
            string? sourceText = null)
        {
            try
            {
                using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
                var component = FindGraphComponent(g, componentId);
                if (component == null || !g.Ownership.TryGetValue(component, out var ownership))
                {
                    return new DesignerAdornerHitInfo
                    {
                        ComponentId = componentId ?? "",
                        AdornerId = adornerId ?? "",
                        ErrorCode = "component_unavailable",
                        Reason = "The component is not present in the current designer graph.",
                    };
                }
                return DesignerDescribe.HitTestDesignerAdorner(
                    g.Host, component, componentId, adornerId, localX, localY, ownership.Editable);
            }
            catch (Exception ex)
            {
                return new DesignerAdornerHitInfo
                {
                    ComponentId = componentId ?? "",
                    AdornerId = adornerId ?? "",
                    ErrorCode = "graph_failed",
                    Reason = "The designer graph could not confirm the hosted adorner: "
                        + ex.GetType().Name + ".",
                };
            }
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
            foreach (IComponent comp in g.GraphComponents)
            {
                if (comp is not Control ctrl) continue;
                bool isRoot = ReferenceEquals(ctrl, root);
                var source = g.Ownership[comp];

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
                    if (ReferenceEquals(p, root)) parentId = "this";
                    else
                    {
                        parentId = SplitterPanelParentId(p, g.Ownership);
                        if (parentId.Length == 0 && g.Ownership.TryGetValue(p, out var parentSource))
                            parentId = parentSource.Id;
                    }
                }

                var (x, y) = ComputeWindowOffset(ctrl, root);
                int outerX = isRoot ? 0 : x;
                int outerY = isRoot ? 0 : y;
                Rectangle client = ComputeClientWindowBounds(ctrl, root, outerX, outerY);
                controls.Add(new LayoutControl
                {
                    Id = source.Id,
                    Name = source.Name,
                    Type = ctrl.GetType().FullName ?? ctrl.GetType().Name,
                    Ownership = source.Ownership,
                    Editable = source.Editable,
                    ReadOnlyReason = source.ReadOnlyReason,
                    InheritedOverrideEditable = source.InheritedPropertyOverrideEditable,
                    InheritedGeometryOverrideEditable = source.InheritedGeometryOverrideEditable,
                    BaseIdentityToken = source.BaseIdentityToken,
                    ParentId = parentId,
                    IsRoot = isRoot,
                    X = isRoot ? 0 : x,
                    Y = isRoot ? 0 : y,
                    Width = isRoot ? frameW : Math.Max(ctrl.Width, 1),
                    Height = isRoot ? frameH : Math.Max(ctrl.Height, 1),
                    ClientX = client.X,
                    ClientY = client.Y,
                    ClientWidth = client.Width,
                    ClientHeight = client.Height,
                    Margin = GeometrySpacing.From(ctrl.Margin),
                    Padding = GeometrySpacing.From(ctrl.Padding),
                    TextBaseline = MeasureTextBaseline(ctrl, client),
                    Depth = depth,
                    ZOrder = isRoot || ctrl.Parent == null ? int.MaxValue : ctrl.Parent.Controls.GetChildIndex(ctrl),
                    TabIndex = isRoot ? -1 : ctrl.TabIndex,
                    Text = ctrl.Text ?? "",
                    HasImage = ctrl is ButtonBase buttonBaseWithImage && buttonBaseWithImage.Image != null,
                    FlatStyle = ctrl is ButtonBase buttonBase ? buttonBase.FlatStyle.ToString() : "",
                    Multiline = ctrl is TextBoxBase textBoxBase && textBoxBase.Multiline,
                    ScrollBars = ctrl is TextBox textBox ? textBox.ScrollBars.ToString() : "",
                    BorderStyle = ctrl is TextBox textBoxBorder ? textBoxBorder.BorderStyle.ToString() : "",
                    Anchor = isRoot ? "None" : ctrl.Anchor.ToString(),
                    Dock = isRoot ? "None" : ctrl.Dock.ToString(),
                    // Only a strip PARENTED into the tree gets on-canvas item geometry (BuildToolStripItems skips
                    // parentless off-tree strips like a ContextMenuStrip), so keep the flag in lockstep — a future
                    // click-to-add path must not route into item mode for a strip with no slot.
                    // Modern tab gestures are intentionally limited to the standard WinForms contract. Vendor tab
                    // hosts need an explicit adapter; reflection-based hidden-page filtering alone grants no verbs.
                    IsTabHost = ctrl is TabControl,
                    IsStripHost = ctrl is ToolStrip && (isRoot || ctrl.Parent != null),
                    TableColumnWidths = ctrl is TableLayoutPanel table ? table.GetColumnWidths() : Array.Empty<int>(),
                    TableRowHeights = ctrl is TableLayoutPanel tableRows ? tableRows.GetRowHeights() : Array.Empty<int>(),
                    FlowDirection = ctrl is FlowLayoutPanel flow ? flow.FlowDirection.ToString() : "",
                    FlowWrapContents = ctrl is FlowLayoutPanel wrappingFlow && wrappingFlow.WrapContents,
                });
            }

            // SplitContainer.Panel1/Panel2 are real design-surface containers but are not ordinary generated fields,
            // so the design host does not site them and GraphComponents cannot enumerate them. Emit stable synthetic
            // nodes anyway: without these rectangles a toolbox hit inside an empty half resolves to the SplitContainer
            // field (which rejects direct Controls.Add) or the form. Visual Studio exposes both panels as container
            // surfaces; the corresponding source identity is `splitContainer1.Panel1|Panel2`.
            foreach (var pair in g.Ownership)
            {
                if (pair.Key is not SplitContainer split || string.IsNullOrWhiteSpace(pair.Value.Id)) continue;
                AddSyntheticSplitterPanel(split.Panel1, "Panel1", split, pair.Value);
                AddSyntheticSplitterPanel(split.Panel2, "Panel2", split, pair.Value);
            }

            void AddSyntheticSplitterPanel(
                SplitterPanel panel,
                string panelName,
                SplitContainer split,
                ComponentOwnershipInfo splitSource)
            {
                if (IsOnHiddenTab(panel, root)) return;
                string id = splitSource.Id + "." + panelName;
                if (controls.Any(control => control.Id == id)) return;
                int depth = 0;
                for (Control? current = panel; current != null && !ReferenceEquals(current, root); current = current.Parent) depth++;
                var (x, y) = ComputeWindowOffset(panel, root);
                Rectangle client = ComputeClientWindowBounds(panel, root, x, y);
                controls.Add(new LayoutControl
                {
                    Id = id,
                    Name = panelName,
                    Type = typeof(SplitterPanel).FullName!,
                    Ownership = splitSource.Ownership,
                    Editable = splitSource.Editable,
                    ReadOnlyReason = splitSource.ReadOnlyReason,
                    ParentId = splitSource.Id,
                    IsRoot = false,
                    X = x,
                    Y = y,
                    Width = Math.Max(panel.Width, 1),
                    Height = Math.Max(panel.Height, 1),
                    ClientX = client.X,
                    ClientY = client.Y,
                    ClientWidth = client.Width,
                    ClientHeight = client.Height,
                    Margin = GeometrySpacing.From(panel.Margin),
                    Padding = GeometrySpacing.From(panel.Padding),
                    TextBaseline = -1,
                    Depth = depth,
                    ZOrder = split.Controls.GetChildIndex(panel),
                    TabIndex = panel.TabIndex,
                    Anchor = panel.Anchor.ToString(),
                    Dock = panel.Dock.ToString(),
                });
            }

            // innermost-first: deepest control, then smallest area — the host takes the first rectangle
            // that contains the click as the visually-topmost target (the form/root, depth 0 and full
            // frame, is last so clicking empty form background selects the form).
            controls.Sort((a, b) =>
            {
                int d = b.Depth.CompareTo(a.Depth);
                if (d != 0) return d;
                int z = a.ZOrder.CompareTo(b.ZOrder);
                if (z != 0) return z;
                int area = ((long)a.Width * a.Height).CompareTo((long)b.Width * b.Height);
                if (area != 0) return area;
                return string.CompareOrdinal(a.Id, b.Id);
            });

            return controls;
        }

        private static string SplitterPanelParentId(Control parent, IReadOnlyDictionary<IComponent, ComponentOwnershipInfo> ownership)
        {
            if (parent is not SplitterPanel splitterPanel || splitterPanel.Parent is not SplitContainer split)
                return "";
            if (!ownership.TryGetValue(split, out var splitSource) || string.IsNullOrWhiteSpace(splitSource.Id))
                return "";
            if (ReferenceEquals(splitterPanel, split.Panel1)) return splitSource.Id + ".Panel1";
            if (ReferenceEquals(splitterPanel, split.Panel2)) return splitSource.Id + ".Panel2";
            return "";
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
            foreach (IComponent comp in g.GraphComponents)
            {
                if (comp is not ToolStrip strip) continue;
                if (!g.Ownership.TryGetValue(strip, out var stripOwnership) || !stripOwnership.Editable) continue;
                // Only strips PARENTED into the visual tree — a ContextMenuStrip / ToolStripDropDownMenu is a sited
                // field but has no parent chain (it's not in any control's Controls), so it's never painted on the
                // surface. Emitting a slot for it would drop a phantom "Type Here" over the form's top-left (its
                // ComputeWindowOffset is just the chrome origin). This matches the net48 engine, which only walks
                // Collect(root) and so never sees an off-tree strip.
                if (!ReferenceEquals(strip, root) && strip.Parent == null) continue;
                if (IsOnHiddenTab(strip, root)) continue;
                string ownerId = stripOwnership.Id;
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
            foreach (IComponent comp in g.GraphComponents)
            {
                if (ReferenceEquals(comp, root)) continue;
                if (comp is Control c && c.Parent != null) continue; // a PARENTED Control lives in the visual layout;
                                                                     // an off-tree Control (ContextMenuStrip) falls through
                if (comp is ToolStripItem) continue;                 // a field-backed strip item is a sited Component,
                                                                     // but Visual Studio never trays strip items — they are
                                                                     // edited on the strip itself (on-canvas Type Here / the
                                                                     // item editor). The tray holds only non-visual components
                                                                     // (Timer/ToolTip/…) + off-tree Controls (ContextMenuStrip).
                var source = g.Ownership[comp];
                string id = source.Id;
                if (id.Length == 0) continue;                 // unnamed/internal (e.g. the IContainer holder) → skip
                tray.Add(new TrayComponent
                {
                    Id = id,
                    Name = source.Name,
                    Type = comp.GetType().FullName ?? comp.GetType().Name,
                    Ownership = source.Ownership,
                    Editable = source.Editable,
                    ReadOnlyReason = source.ReadOnlyReason,
                    IconPng = DesignerControlEditor.ToolboxIconPng(comp.GetType()),
                    // An OFF-TREE ToolStrip (a ContextMenuStrip) carries its top-level Items so the canvas can open a
                    // synthetic flyout from its tray chip; a non-strip component leaves this empty.
                    Items = source.Editable && comp is ToolStrip strip ? BuildStripItemForest(strip, id) : new(),
                    IsStrip = source.Editable && comp is ToolStrip, // read-only inherited strips remain selectable tray components, never item-edit hosts
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
            return DesignerDescribe.Describe(g.Host, g.ClassName, g.ExplicitMembers, g.Total, g.Representable, g.Unrepresentable, g.EventWirings, mods, g.GraphComponents, g.Ownership, g.ControlAssemblyPath);
        }

        /// <summary>Describe one component by edit id ("this" = root) — the bounded per-selection path for a grid.</summary>
        public static ComponentInfo? DescribeComponent(string designerFilePath, string componentId, string? controlAssemblyPath = null, string? sourceText = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            var mods = DesignerModifiers.ParseFieldModifiers(sourceText ?? SafeRead(designerFilePath));
            return DesignerDescribe.DescribeComponent(g.Host, g.ClassName, g.ExplicitMembers, componentId, g.EventWirings, mods, g.GraphComponents, g.Ownership, g.ControlAssemblyPath);
        }

        /// <summary>Read a file's text for a describe pseudo-property parse; empty on any IO error (the pseudo-props
        /// simply won't be injected — describe still works).</summary>
        private static string SafeRead(string path)
        {
            try { return File.ReadAllText(path); }
            catch { return ""; }
        }

        private static string? CurrentSourceOwnershipError(string source, string componentId)
        {
            if (componentId is "this" or "") return null;
            try
            {
                var form = FormClassResolver.FormClass(CSharpSyntaxTree.ParseText(source).GetRoot());
                if (form != null && (FormClassResolver.FieldNamesOf(form).Contains(componentId)
                    || IsCurrentSourceSyntheticContainerPath(form, componentId))) return null;
            }
            catch { /* malformed/ambiguous source is rejected below */ }
            return "component '" + componentId + "' is not declared by the current designer source (inherited or unresolved components are read-only)";
        }

        /// <summary>Validate the bounded source-spellable identity used for framework-owned design containers.
        /// SplitContainer panels are real editable surfaces but never fields of their own; the only safe path is an
        /// exact current-source SplitContainer field followed by Panel1 or Panel2. Alias-based/unknown field types are
        /// deliberately refused rather than granting a direct RPC an arbitrary member-access splice.</summary>
        private static bool IsCurrentSourceSyntheticContainerPath(ClassDeclarationSyntax form, string componentId)
        {
            string[] parts = componentId.Split('.');
            if (parts.Length != 2 || (parts[1] != "Panel1" && parts[1] != "Panel2")) return false;
            foreach (var field in form.Members.OfType<FieldDeclarationSyntax>())
            {
                if (!field.Declaration.Variables.Any(variable => variable.Identifier.Text == parts[0])) continue;
                string type = field.Declaration.Type.ToString().Replace("global::", "", StringComparison.Ordinal).Trim();
                return type == "SplitContainer" || type.EndsWith(".SplitContainer", StringComparison.Ordinal);
            }
            return false;
        }

        private const int MaxMultiPropertyTargets = 128;

        /// <summary>Validate the closed target set accepted by the multi-object property adapters. The caller supplies
        /// webview-originated ids, so an empty/duplicate/oversized set or an identifier that is not owned by the current
        /// designer source is rejected before the first candidate splice is computed.</summary>
        private static string[]? ValidateMultiPropertyTargets(string source, IReadOnlyList<string>? componentIds,
            string propertyName, out string reason)
        {
            reason = "";
            if (componentIds == null || componentIds.Count < 2)
            {
                reason = "multi-object property edit requires at least two targets";
                return null;
            }
            if (componentIds.Count > MaxMultiPropertyTargets)
            {
                reason = "multi-object property edit exceeds the " + MaxMultiPropertyTargets + " target limit";
                return null;
            }
            if (!DesignerControlEditor.IsValidIdentifier(propertyName))
            {
                reason = "invalid property name: " + propertyName;
                return null;
            }

            var seen = new HashSet<string>(StringComparer.Ordinal);
            var ids = new string[componentIds.Count];
            for (int i = 0; i < componentIds.Count; i++)
            {
                string id = componentIds[i] ?? "";
                if (id.Length == 0 || !seen.Add(id))
                {
                    reason = id.Length == 0 ? "multi-object property target is empty" : "duplicate multi-object property target: " + id;
                    return null;
                }
                string? ownershipError = CurrentSourceOwnershipError(source, id);
                if (ownershipError != null)
                {
                    reason = ownershipError;
                    return null;
                }
                ids[i] = id;
            }
            return ids;
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
            string? ownershipError = CurrentSourceOwnershipError(src, componentName);
            if (ownershipError != null)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = ownershipError };
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

        /// <summary>Apply one bounded derived-source override for an inherited framework control. Unlike
        /// <see cref="ApplyPropertyEdit"/>, this path loads the current base graph, recomputes the observed field
        /// identity, and accepts only the opaque token previously issued by that graph. The client supplies no field
        /// type, accessibility, property type, or observed token; all of them are derived again here.</summary>
        public static PropertyEditResult ApplyInheritedPropertyOverride(
            string designerFilePath,
            string componentName,
            string propertyName,
            string newValueExpr,
            string expectedBaseIdentityToken,
            string? controlAssemblyPath = null,
            string? sourceText = null) => EditInheritedPropertyOverride(
                designerFilePath, componentName, propertyName, newValueExpr, expectedBaseIdentityToken,
                controlAssemblyPath, sourceText, remove: false);

        public static PropertyEditResult RemoveInheritedPropertyOverride(
            string designerFilePath,
            string componentName,
            string propertyName,
            string expectedBaseIdentityToken,
            string? controlAssemblyPath = null,
            string? sourceText = null) => EditInheritedPropertyOverride(
                designerFilePath, componentName, propertyName, "", expectedBaseIdentityToken,
                controlAssemblyPath, sourceText, remove: true);

        private static PropertyEditResult EditInheritedPropertyOverride(
            string designerFilePath,
            string componentName,
            string propertyName,
            string newValueExpr,
            string expectedBaseIdentityToken,
            string? controlAssemblyPath,
            string? sourceText,
            bool remove)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            try
            {
                using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
                var match = g.Ownership.FirstOrDefault(kv => kv.Value.Id == componentName);
                if (match.Key == null || match.Value.Ownership != "inherited"
                    || !match.Value.InheritedPropertyOverrideEditable)
                    return new PropertyEditResult
                    {
                        Mode = EditMode.Failed,
                        Encoding = encoding,
                        Reason = match.Key == null ? "inherited component not found: " + componentName
                            : match.Value.ReadOnlyReason ?? "inherited component is not eligible for derived overrides",
                    };
                if (!remove && DesignerInheritedOverrideEditor.IsGeometryProperty(propertyName)
                    && !match.Value.InheritedGeometryOverrideEditable)
                    return new PropertyEditResult
                    {
                        Mode = EditMode.Failed,
                        Encoding = encoding,
                        Reason = "inherited geometry is managed by Dock, AutoSize, or a layout-panel parent",
                    };

                PropertyDescriptor? descriptor;
                try { descriptor = TypeDescriptor.GetProperties(match.Key).Find(propertyName, ignoreCase: false); }
                catch (Exception ex)
                {
                    return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding,
                        Reason = "inherited property metadata failed: " + ex.GetType().Name + ": " + ex.Message };
                }
                string propertyType = descriptor?.PropertyType.FullName ?? "";
                if (descriptor == null || !descriptor.IsBrowsable || descriptor.IsReadOnly
                    || !DesignerInheritedOverrideEditor.SupportsProperty(propertyName, propertyType))
                    return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding,
                        Reason = "property is not eligible for an inherited override: " + propertyName };

                var request = new InheritedOverrideEditRequest
                {
                    SourceText = src,
                    FieldId = match.Value.Id,
                    FieldTypeName = match.Value.InheritedFieldType,
                    EffectiveAccessibility = match.Value.EffectiveAccessibility,
                    PropertyName = propertyName,
                    PropertyTypeName = propertyType,
                    ValueExpression = newValueExpr,
                    ExpectedBaseIdentityToken = expectedBaseIdentityToken,
                    ObservedBaseIdentityToken = match.Value.BaseIdentityToken,
                };
                Type? resolvedFieldType = match.Value.InheritedResolvedFieldType;
                Type resolvedRuntimeType = match.Key.GetType();
                if (resolvedFieldType == null)
                    return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding,
                        Reason = "inherited field type is no longer resolved by the live designer graph" };
                var edit = remove
                    ? DesignerInheritedOverrideEditor.TryRemove(request, resolvedFieldType, resolvedRuntimeType)
                    : DesignerInheritedOverrideEditor.TryApply(request, resolvedFieldType, resolvedRuntimeType);
                if (!edit.Safe || edit.NewText == null)
                    return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };
                return new PropertyEditResult
                {
                    Mode = edit.Mode == InheritedOverrideEditMode.Insert ? EditMode.Insert : EditMode.Replace,
                    Encoding = encoding,
                    ParseOk = true,
                    Minimal = true,
                    NewText = edit.NewText,
                };
            }
            catch (Exception ex)
            {
                return new PropertyEditResult
                {
                    Mode = EditMode.Failed,
                    Encoding = encoding,
                    Reason = "inherited override authorization failed: " + ex.GetType().Name + ": " + ex.Message,
                };
            }
        }

        /// <summary>Compute one all-or-nothing multi-object scalar-property edit. Every target is first authorized
        /// independently against the exact same source snapshot; only then are the already-safe targeted splices
        /// composed in memory. A refusal at either phase returns no text, so the host cannot commit a prefix of the
        /// selection. Each constituent splice retains <see cref="DesignerPropertyEditor.OnlyTargetChanged"/> and the
        /// host applies the final text as one undo unit.</summary>
        public static PropertyEditResult ApplyPropertyEdits(string designerFilePath, IReadOnlyList<string> componentIds,
            string propertyName, string newValueExpr, string? sourceText = null)
        {
            string source;
            Encoding encoding;
            if (sourceText != null) { source = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, source) = ReadWithEncoding(designerFilePath); }

            var ids = ValidateMultiPropertyTargets(source, componentIds, propertyName, out string targetReason);
            if (ids == null)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = targetReason };

            // Preflight every member against ONE immutable snapshot. This catches an unsafe insertion anchor,
            // malformed expression, inherited/unresolved id, or safety-gate refusal before batch composition begins.
            foreach (string id in ids)
            {
                var candidate = ApplyPropertyEdit(designerFilePath, id, propertyName, newValueExpr, source);
                if (!candidate.Safe)
                    return new PropertyEditResult
                    {
                        Mode = EditMode.Failed,
                        Encoding = encoding,
                        Reason = "target '" + id + "' refused " + propertyName + ": " + candidate.Reason,
                    };
            }

            string text = source;
            EditMode aggregateMode = EditMode.Replace;
            foreach (string id in ids)
            {
                var applied = ApplyPropertyEdit(designerFilePath, id, propertyName, newValueExpr, text);
                if (!applied.Safe || applied.NewText == null)
                    return new PropertyEditResult
                    {
                        Mode = EditMode.Failed,
                        Encoding = encoding,
                        Reason = "target '" + id + "' could not be composed atomically: " + applied.Reason,
                    };
                if (applied.Mode == EditMode.Insert) aggregateMode = EditMode.Insert;
                text = applied.NewText;
            }

            bool parseOk = !CSharpSyntaxTree.ParseText(text).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            return new PropertyEditResult
            {
                Mode = parseOk ? aggregateMode : EditMode.Failed,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = parseOk,
                NewText = parseOk ? text : null,
                Reason = parseOk ? "" : "multi-object edited text has syntax errors",
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

            string? ownershipError = CurrentSourceOwnershipError(src, childId);
            if (ownershipError != null)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = ownershipError };

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
            string? ownershipError = CurrentSourceOwnershipError(src, componentName);
            if (ownershipError != null) return new PropertyResetResult { Ok = false, Reason = ownershipError };
            return DesignerPropertyEditor.ResetProperty(src, componentName, propertyName);
        }

        /// <summary>All-or-nothing multi-object Reset. A target with no explicit assignment is a representable no-op;
        /// a target whose assignment cannot be removed without losing comments/directives/other statements rejects the
        /// whole batch. The returned text therefore contains every reset or none of them.</summary>
        public static PropertyResetResult ApplyPropertyResets(string designerFilePath, IReadOnlyList<string> componentIds,
            string propertyName, string? sourceText = null)
        {
            string source = sourceText ?? ReadWithEncoding(designerFilePath).text;
            var ids = ValidateMultiPropertyTargets(source, componentIds, propertyName, out string targetReason);
            if (ids == null) return new PropertyResetResult { Ok = false, Reason = targetReason };

            foreach (string id in ids)
            {
                var candidate = ApplyPropertyReset(designerFilePath, id, propertyName, source);
                if (!candidate.Ok)
                    return new PropertyResetResult
                    {
                        Ok = false,
                        Reason = "target '" + id + "' refused reset of " + propertyName + ": " + candidate.Reason,
                    };
            }

            string text = source;
            bool changed = false;
            foreach (string id in ids)
            {
                var applied = ApplyPropertyReset(designerFilePath, id, propertyName, text);
                if (!applied.Ok)
                    return new PropertyResetResult
                    {
                        Ok = false,
                        Reason = "target '" + id + "' could not be reset atomically: " + applied.Reason,
                    };
                if (applied.Changed && applied.NewText != null)
                {
                    text = applied.NewText;
                    changed = true;
                }
            }

            return new PropertyResetResult
            {
                Ok = true,
                Changed = changed,
                NewText = changed ? text : null,
                Reason = changed ? "" : "all selected properties are already at their defaults",
            };
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

        /// <summary>List existing project image/bitmap/icon resources from the host-supplied .resx +
        /// Resources.Designer.cs texts. No file-ref target is opened; only safe metadata and generated accessors are
        /// cross-checked.</summary>
        public static ProjectResourceListResult ListProjectImageResources(string? resxText, string? resourcesDesignerSource) =>
            DesignerProjectResourcePicker.ListImageResources(resxText, resourcesDesignerSource);

        /// <summary>Bind an image-like property to an existing strongly typed project resource. This mutates only the
        /// form's .Designer.cs by routing the generated expression through the same byte-local property editor used by
        /// scalar grid edits; the project .resx is not copied or rewritten.</summary>
        public static PropertyEditResult ApplyProjectImageResource(string designerFilePath, string componentName,
            string propertyName, string propertyTypeName, string? resxText, string? resourcesDesignerSource,
            string resourceClassFullName, string resourcePropertyName, string? sourceText = null)
        {
            string source;
            Encoding encoding;
            if (sourceText != null) { source = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, source) = ReadWithEncoding(designerFilePath); }

            string? expr = DesignerProjectResourcePicker.BuildResourceExpression(
                resxText, resourcesDesignerSource, resourceClassFullName, resourcePropertyName, propertyTypeName, out string reason);
            if (expr == null)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = reason };

            var edit = ApplyPropertyEdit(designerFilePath, componentName, propertyName, expr, source);
            return new PropertyEditResult
            {
                Mode = edit.Mode,
                NewText = edit.NewText,
                Encoding = encoding,
                ParseOk = edit.ParseOk,
                Minimal = edit.Minimal,
                Reason = edit.Reason,
            };
        }

        /// <summary>0.11.0 ImageList editor — embed a serialized ImageStream blob (from the net48 serializer) into the
        /// sibling .resx + rewrite the ImageList's init to the canonical ImageStream + SetKeyName form. Returns both new
        /// texts; the host persists them atomically + undoably.</summary>
        public static ImageListEditResult ApplySetImageList(string designerFilePath, string componentId,
            string imageStreamBase64, string[] keys, string? resxText, string? sourceText = null,
            string[]? oldKeys = null, int[]? oldIndexForNew = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerImageListEditor.SetImages(src, componentId, resxText, imageStreamBase64, keys,
                oldKeys, oldIndexForNew);
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

        public static DesignerGenericListItemsResult ListGenericListItems(string designerFilePath, string ownerId,
            string propertyName, string itemTypeName, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerGenericListEditor.ListItems(src, ownerId, propertyName, itemTypeName);
        }

        public static DesignerGenericListEditResult ApplyGenericListEdit(string designerFilePath, string ownerId,
            string propertyName, string itemTypeName, IReadOnlyList<string> items, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            string? ownershipError = CurrentSourceOwnershipError(src, ownerId);
            if (ownershipError != null)
                return new DesignerGenericListEditResult { Reason = ownershipError };
            return DesignerGenericListEditor.SetItems(src, ownerId, propertyName, itemTypeName, items);
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

            string? ownershipError = CurrentSourceOwnershipError(src, ownerId);
            if (ownershipError != null)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = ownershipError };

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

        /// <summary>Read a DataGridView's current columns (identity, display, binding, and supported cell-style
        /// fields) for the typed grid-column editor. Pure text parse of InitializeComponent — no graph load / STA.</summary>
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

        /// <summary>Read a control's canonical <c>DataBindings.Add(new Binding(...))</c> statements and the
        /// component fields that are valid source choices. Pure text parse; no graph load or user-code execution.</summary>
        public static BindingItemsResult ListBindingItems(string designerFilePath, string ownerId, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerBindingEditor.ListBindings(src, ownerId);
        }

        /// <summary>Replace only one control's canonical DataBindings statements, with a parse and minimal-diff gate.</summary>
        public static PropertyEditResult ApplyBindingsEdit(string designerFilePath, string ownerId,
            IReadOnlyList<BindingItem> bindings, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }

            var edit = DesignerBindingEditor.SetBindings(src, ownerId, bindings);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerBindingEditor.OnlyBindingsChanged(src, edit.NewText, ownerId);
            bool safe = parseOk && minimal;
            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk
                    ? "edited text has syntax errors"
                    : "edit changed more than the target DataBindings"),
            };
        }

        /// <summary>Read a BindingSource/ListControl/DataGridView DataSource assignment and safe choices.</summary>
        public static DataSourceResult GetDataSourceInfo(string designerFilePath, string ownerId, string? sourceText = null)
        {
            string src = sourceText ?? ReadWithEncoding(designerFilePath).text;
            return DesignerBindingEditor.GetDataSource(src, ownerId);
        }

        /// <summary>Discover bounded project DTO schemas and conventional application settings for the Data Sources pane.</summary>
        public static DataSourcesResult ListProjectDataSources(string designerFilePath, string? sourceText = null)
            => DesignerDataSourceGenerator.ListDataSources(designerFilePath, sourceText);

        /// <summary>Generate a bounded detail/grid data-binding surface as one source edit.</summary>
        public static DataSourceGenerationResult GenerateProjectDataSource(
            string designerFilePath,
            string schemaKey,
            string mode,
            string parentId,
            int x,
            int y,
            bool includeNavigator,
            string? existingBindingSourceId = null,
            string? existingGridId = null,
            string? sourceText = null)
            => DesignerDataSourceGenerator.GenerateDataSource(
                designerFilePath,
                schemaKey ?? "",
                mode ?? "",
                parentId ?? "this",
                x,
                y,
                includeNavigator,
                existingBindingSourceId,
                existingGridId,
                sourceText);

        /// <summary>Bind one discovered application setting to a compatible selected control.</summary>
        public static DataSourceGenerationResult BindProjectApplicationSetting(
            string designerFilePath,
            string settingKey,
            string targetId,
            string? sourceText = null)
            => DesignerDataSourceGenerator.BindApplicationSetting(
                designerFilePath,
                settingKey ?? "",
                targetId ?? "",
                sourceText);

        /// <summary>Set DataSource through the closed null/component/typeof(Type) workflow.</summary>
        public static PropertyEditResult ApplyDataSourceEdit(string designerFilePath, string ownerId,
            string kind, string value, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }
            var edit = DesignerBindingEditor.SetDataSource(src, ownerId, kind, value);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };
            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerPropertyEditor.OnlyTargetChanged(src, edit.NewText, ownerId, "DataSource", edit.Mode);
            bool safe = parseOk && minimal;
            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than DataSource"),
            };
        }

        /// <summary>Set a common framework extender value through provider.SetX(target, value).</summary>
        public static PropertyEditResult ApplyExtenderEdit(string designerFilePath, string providerId,
            string targetId, string propertyName, string propertyType, string rawValue, string? sourceText = null)
        {
            string src;
            Encoding encoding;
            if (sourceText != null) { src = sourceText; encoding = new UTF8Encoding(false); }
            else { (encoding, src) = ReadWithEncoding(designerFilePath); }
            var edit = DesignerExtenderEditor.SetValue(src, providerId, targetId, propertyName, propertyType, rawValue);
            if (edit.Mode == EditMode.Failed)
                return new PropertyEditResult { Mode = EditMode.Failed, Encoding = encoding, Reason = edit.Reason };
            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerExtenderEditor.OnlyExtenderChanged(
                src, edit.NewText, providerId, targetId, propertyName, edit.Mode);
            bool safe = parseOk && minimal;
            return new PropertyEditResult
            {
                Mode = edit.Mode,
                Encoding = encoding,
                ParseOk = parseOk,
                Minimal = minimal,
                NewText = safe ? edit.NewText : null,
                Reason = safe ? "" : (!parseOk ? "edited text has syntax errors" : "edit changed more than the extender value"),
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
            string? handlerName, string? designerSourceText, string? codeText, string? controlAssemblyPath = null,
            IReadOnlyList<string>? projectCodeTexts = null)
        {
            string designerSrcForOwnership = designerSourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(designerSrcForOwnership, componentId);
            if (ownershipError != null) return new EventGenResult { Safe = false, Reason = ownershipError };
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, designerSourceText);

            bool isRoot = componentId is "this" or "";
            System.ComponentModel.IComponent? comp = FindGraphComponent(g, componentId);
            if (comp == null) return new EventGenResult { Safe = false, Reason = "component not found: " + componentId };

            var ed = System.ComponentModel.TypeDescriptor.GetEvents(comp)[eventName];
            var del = ed?.EventType;
            var invoke = del?.GetMethod("Invoke");
            if (del == null || invoke == null) return new EventGenResult { Safe = false, Reason = "event/delegate not found: " + eventName };
            var eventCodeTexts = EventCodeTexts(codeText, projectCodeTexts);

            string idKey = isRoot ? "this" : componentId;
            string compName = isRoot
                ? g.ClassName
                : componentId.Contains('.', StringComparison.Ordinal)
                    ? componentId.Replace('.', '_')
                    : (comp.Site?.Name ?? componentId);

            // already wired in the source? → don't add a second wiring; only generate a missing stub.
            string? existing = null;
            if (g.EventWirings.TryGetValue(idKey, out var wmap)) wmap.TryGetValue(eventName, out existing);

            if (existing != null)
            {
                bool needsStub = codeText != null && !DesignerEventEditor.HasMethodInFiles(eventCodeTexts, g.ClassQualifiedName, existing);
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
            var parameterTypes = invoke.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList();
            var compatibleHandlers = DesignerEventEditor.FindCompatibleHandlersInFiles(
                eventCodeTexts, g.ClassQualifiedName, parameterTypes, invoke.ReturnType.FullName ?? invoke.ReturnType.Name);
            bool handlerExists = DesignerEventEditor.HasMethodInFiles(eventCodeTexts, g.ClassQualifiedName, handler);
            if (handlerExists && !compatibleHandlers.Contains(handler, StringComparer.Ordinal))
                return new EventGenResult { Safe = false, HandlerName = handler, Reason = "handler '" + handler + "' exists in a project partial but does not match the event's signature" };
            // A compatible handler may already live in another project partial; wire it without generating a duplicate.
            // Otherwise the primary code-behind remains the deterministic insertion target.
            if (!handlerExists && codeText == null)
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
            if (!handlerExists)
            {
                var stub = MakeStub(codeText!, g.ClassQualifiedName, handler, invoke);
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
            string designerFilePath, string componentId, string? designerSourceText, string? codeText,
            string? controlAssemblyPath = null, IReadOnlyList<string>? projectCodeTexts = null)
        {
            var list = new List<EventCandidates>();
            var eventCodeTexts = EventCodeTexts(codeText, projectCodeTexts);
            if (eventCodeTexts.Count == 0) return list;
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, designerSourceText);
            bool isRoot = componentId is "this" or "";
            System.ComponentModel.IComponent? comp = FindGraphComponent(g, componentId);
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
                    cands = DesignerEventEditor.FindCompatibleHandlersInFiles(eventCodeTexts, g.ClassQualifiedName, pnames, retName);
                    bySig[sig] = cands;
                }
                if (cands.Count > 0) list.Add(new EventCandidates { Event = ed.Name, Handlers = cands });
            }
            return list;
        }

        /// <summary>Resolve a handler to the exact project partial source that declares it. The form's fully-qualified
        /// identity comes from the loaded designer graph; same-named methods on unrelated classes are ignored.</summary>
        public static int FindEventHandlerSourceIndex(string designerFilePath, string handlerName,
            IReadOnlyList<string>? projectCodeTexts, string? designerSourceText = null,
            string? controlAssemblyPath = null)
        {
            if (!DesignerEventEditor.IsValidIdentifier(handlerName) || projectCodeTexts == null) return -1;
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, designerSourceText);
            for (int i = 0; i < projectCodeTexts.Count; i++)
                if (DesignerEventEditor.HasMethod(projectCodeTexts[i] ?? "", g.ClassQualifiedName, handlerName)) return i;
            return -1;
        }

        /// <summary>
        /// Wire / rewire / unwire an event to an EXISTING code-behind handler (the events dropdown write
        /// path). Edits only the .Designer.cs. handlerName null → unwire. When non-null, the method must
        /// already exist in the code-behind (codeText) — wiring to a missing method would not compile.
        /// </summary>
        public static EventWiringResult SetEventWiring(
            string designerFilePath, string componentId, string eventName, string? handlerName,
            string? designerSourceText, string? codeText, string? controlAssemblyPath = null,
            IReadOnlyList<string>? projectCodeTexts = null)
        {
            string designerSrcForOwnership = designerSourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(designerSrcForOwnership, componentId);
            if (ownershipError != null) return new EventWiringResult { Safe = false, Reason = ownershipError };
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, designerSourceText);
            bool isRoot = componentId is "this" or "";
            System.ComponentModel.IComponent? comp = FindGraphComponent(g, componentId);
            if (comp == null) return new EventWiringResult { Safe = false, Reason = "component not found: " + componentId };
            var ed = System.ComponentModel.TypeDescriptor.GetEvents(comp)[eventName];
            var del = ed?.EventType;
            if (del == null) return new EventWiringResult { Safe = false, Reason = "event not found: " + eventName };

            string idKey = isRoot ? "this" : componentId;
            string? handler = handlerName != null && handlerName.Trim().Length > 0 ? handlerName.Trim() : null;
            bool wired = g.EventWirings.TryGetValue(idKey, out var wmap) && wmap.ContainsKey(eventName);

            if (handler == null && !wired)
                return new EventWiringResult { Safe = false, Reason = "event is not wired" };
            // Wiring to a method that doesn't exist would not compile — but neither does wiring to one whose SIGNATURE
            // isn't the delegate's. This checked existence by NAME only, so `void WrongClick(string text)` could be
            // wired to Click and the build broke. The dropdown already filters by signature; this is the write
            // path, which the panel can reach with any value, so it must apply the SAME rule rather than trust it.
            if (handler != null)
            {
                var eventCodeTexts = EventCodeTexts(codeText, projectCodeTexts);
                if (eventCodeTexts.Count == 0)
                    return new EventWiringResult { Safe = false, Reason = "no project code snapshot was supplied to validate handler '" + handler + "'" };
                var invoke = del.GetMethod("Invoke");
                if (invoke == null)
                    return new EventWiringResult { Safe = false, Reason = "event delegate has no Invoke: " + eventName };
                var pnames = invoke.GetParameters().Select(p => p.ParameterType.FullName ?? p.ParameterType.Name).ToList();
                var compatible = DesignerEventEditor.FindCompatibleHandlersInFiles(
                    eventCodeTexts, g.ClassQualifiedName, pnames, invoke.ReturnType.FullName ?? invoke.ReturnType.Name);
                if (!compatible.Contains(handler, StringComparer.Ordinal))
                    return new EventWiringResult
                    {
                        Safe = false,
                        Reason = DesignerEventEditor.HasMethodInFiles(eventCodeTexts, g.ClassQualifiedName, handler)
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

        private static List<string> EventCodeTexts(string? primaryCodeText, IReadOnlyList<string>? projectCodeTexts)
        {
            var texts = new List<string>();
            if (primaryCodeText != null) texts.Add(primaryCodeText);
            if (projectCodeTexts != null)
                foreach (string? text in projectCodeTexts)
                    if (text != null && !texts.Contains(text, StringComparer.Ordinal)) texts.Add(text);
            return texts;
        }

        /// <summary>
        /// Toolbox "add control": add a standard WinForms control to the .Designer.cs as a MINIMAL text edit
        /// (field declaration + InitializeComponent statements). Pure text — NO graph load (the generated
        /// statements are interpreted by the existing engine on the next render, which creates the control via
        /// host.CreateComponent). parentId "this" = the root form. The host applies the returned text unsaved.
        /// </summary>
        public static ControlAddResult AddControl(string designerFilePath, string parentId, string controlTypeKey, string? sourceText = null, int? locX = null, int? locY = null, string? controlAssemblyPath = null, IReadOnlyList<string>? projectControlFqns = null, string? autoScaleDimensions = null, int? width = null, int? height = null)
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
            return DesignerControlEditor.AddControl(src, parentId, controlTypeKey, projectControls, locX, locY, autoScaleDimensions, width, height);
        }

        /// <summary>Add a control to an already-localizable form. The ordinary bounded add composes the structural
        /// source first; only its newly-emitted localizable assignments are then lifted into the neutral .resx and
        /// replaced by ApplyResources. The caller persists source and resource as one transaction.</summary>
        public static ControlAddResult AddLocalizedControl(string designerFilePath, string parentId,
            string controlTypeKey, string? sourceText, string? resxText, int? locX = null, int? locY = null,
            string? controlAssemblyPath = null, IReadOnlyList<string>? projectControlFqns = null,
            string? autoScaleDimensions = null, int? width = null, int? height = null)
        {
            var added = AddControl(designerFilePath, parentId, controlTypeKey, sourceText, locX, locY,
                controlAssemblyPath, projectControlFqns, autoScaleDimensions, width, height);
            if (!added.Safe || added.NewText == null) return added;
            var localized = DesignerLocalizeForm.ApplyAddedControl(added.NewText, added.Name, resxText);
            if (!localized.Safe || localized.NewText == null || localized.ResxText == null)
                return new ControlAddResult { Safe = false, Name = added.Name, Reason = localized.Reason };
            return new ControlAddResult
            {
                Safe = true,
                Name = added.Name,
                NewText = localized.NewText,
                ResxText = localized.ResxText,
                ResourceKeys = localized.Keys,
            };
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
                    var asm = alc.LoadNoLock(full);
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
        public static ToolboxScanResult ScanAssemblyCandidates(string asmPath, bool fromProject, IReadOnlyList<string>? probeDirectories = null)
        {
            string simpleName = string.IsNullOrEmpty(asmPath) ? "" : Path.GetFileNameWithoutExtension(asmPath);
            if (string.IsNullOrEmpty(asmPath) || !File.Exists(asmPath))
                return new ToolboxScanResult { AssemblyName = simpleName, Error = "file not found" };
            string full = Path.GetFullPath(asmPath);
            long mtime; try { mtime = File.GetLastWriteTimeUtc(full).Ticks; } catch { mtime = 0; }
            string probeKey = string.Join("|", (probeDirectories ?? Array.Empty<string>())
                .Where(p => !string.IsNullOrWhiteSpace(p))
                .Select(p => { try { return Path.GetFullPath(p); } catch { return ""; } })
                .Where(p => p.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .OrderBy(p => p, StringComparer.OrdinalIgnoreCase));
            string cacheKey = full + "\0" + probeKey;
            lock (_projCtlLock)
            {
                if (_candidateCache.TryGetValue(cacheKey, out var c) && c.mtime == mtime) return c.result;
                var result = ScanAssemblyCandidatesCore(full, simpleName, fromProject, probeDirectories, out var unloadReference);
                // AssemblyLoadContext.Unload() only starts unloading. Run collection after the no-inline helper
                // returns so no Assembly/Type locals remain JIT-live, which hands the scanned graph's MEMORY back
                // promptly. Its files were never held (the scan byte-loads — see ControlLoadContext), so replacing a
                // browsed library right after a scan no longer depends on this collection happening.
                WaitForCollectibleUnload(unloadReference);
                _candidateCache[cacheKey] = (mtime, result);
                return result;
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private static ToolboxScanResult ScanAssemblyCandidatesCore(
            string full, string simpleName, bool fromProject, IReadOnlyList<string>? probeDirectories,
            out WeakReference? unloadReference)
        {
            ControlLoadContext? alc = null;
            unloadReference = null;
            try
            {
                alc = new ControlLoadContext(full, probeDirectories);
                var asm = alc.LoadNoLock(full);
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
                return new ToolboxScanResult
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
                return new ToolboxScanResult { AssemblyName = simpleName, Error = why };
            }
            finally
            {
                if (alc != null)
                {
                    unloadReference = new WeakReference(alc, trackResurrection: true);
                    alc.Unload();
                }
            }
        }

        private static void WaitForCollectibleUnload(WeakReference? unloadReference)
        {
            for (int attempt = 0; unloadReference?.IsAlive == true && attempt < 10; attempt++)
            {
                GC.Collect();
                GC.WaitForPendingFinalizers();
                GC.Collect();
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
            string? ownershipError = CurrentSourceOwnershipError(src, controlId);
            if (ownershipError != null) return new ControlRemoveResult { Safe = false, Reason = ownershipError };
            return DesignerControlEditor.RemoveControl(src, controlId);
        }

        /// <summary>Rename a component field and its this.field references. Pure text; primarily used by tray chips.</summary>
        public static ControlAddResult RenameComponent(string designerFilePath, string oldId, string newId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(src, oldId);
            if (ownershipError != null) return new ControlAddResult { Safe = false, Reason = ownershipError };
            return DesignerComponentRename.Rename(src, oldId, newId);
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

        /// <summary>Move a tab page one source-collection position left/right. Pure text, no graph load; supports
        /// canonical Controls/TabPages Add and AddRange shapes and preserves every non-attachment statement.</summary>
        public static ControlReorderResult MoveTabPage(string designerFilePath, string hostId, string pageId, bool left, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(src, hostId)
                ?? CurrentSourceOwnershipError(src, pageId);
            if (ownershipError != null) return new ControlReorderResult { Safe = false, Reason = ownershipError };
            return DesignerControlEditor.MoveTabPage(src, hostId, pageId, left);
        }

        /// <summary>Read one standard TabControl's field-backed page ids in canonical source collection order.
        /// Pure text, no graph load; ambiguous/non-current-source collections are returned read-only.</summary>
        public static TabPageItemsResult ListTabPages(string designerFilePath, string hostId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(src, hostId);
            if (ownershipError != null) return new TabPageItemsResult { Ok = false, Reason = ownershipError };
            return DesignerControlEditor.ListTabPages(src, hostId);
        }

        /// <summary>Atomically apply an exact TabPages permutation as a minimal source edit. Pure text, no graph load.</summary>
        public static ControlReorderResult SetTabPageOrder(string designerFilePath, string hostId,
            IReadOnlyList<string> desiredOrder, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(src, hostId);
            if (ownershipError != null) return new ControlReorderResult { Safe = false, Reason = ownershipError };
            foreach (string pageId in desiredOrder ?? Array.Empty<string>())
            {
                ownershipError = CurrentSourceOwnershipError(src, pageId);
                if (ownershipError != null) return new ControlReorderResult { Safe = false, Reason = ownershipError };
            }
            return DesignerControlEditor.SetTabPageOrder(src, hostId, desiredOrder ?? Array.Empty<string>());
        }

        /// <summary>Reparent a leaf control into a different container / the root as a MINIMAL text edit —
        /// rewrites only the receiver of its Controls.Add, plus an optional parent-relative Location. Pure text, no graph load. See
        /// <see cref="DesignerControlEditor.Reparent"/>.</summary>
        public static ControlReorderResult ReparentControl(string designerFilePath, string childId, string newParentId, string? sourceText = null, int? locX = null, int? locY = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(src, childId)
                ?? CurrentSourceOwnershipError(src, ReparentOwnershipId(newParentId));
            if (ownershipError != null) return new ControlReorderResult { Safe = false, Reason = ownershipError };
            return DesignerControlEditor.Reparent(src, childId, newParentId, locX, locY);
        }

        private static string ReparentOwnershipId(string parentId)
        {
            if (parentId is "this" or "") return parentId;
            int dot = parentId.IndexOf('.');
            return dot < 0 ? parentId : parentId.Substring(0, dot);
        }

        /// <summary>Copy a leaf control to an opaque clipboard blob (field type + its InitializeComponent
        /// statements). Pure text — no graph load. See <see cref="DesignerControlEditor.CopyControl"/>.</summary>
        public static ControlCopyResult CopyControl(string designerFilePath, string controlId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(src, controlId);
            if (ownershipError != null) return new ControlCopyResult { Safe = false, Reason = ownershipError };
            return DesignerControlEditor.CopyControl(src, controlId);
        }

        /// <summary>Paste a clipboard blob (from <see cref="CopyControl"/>) into a container as a fresh control.
        /// Pure text — no graph load. See <see cref="DesignerControlEditor.PasteControl"/>.</summary>
        public static ControlPasteResult PasteControl(string designerFilePath, string clip, string parentId, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.PasteControl(src, clip, parentId);
        }

        /// <summary>Paste a clipboard control at an exact offset from its original Location.</summary>
        public static ControlPasteResult PasteControlAtOffset(string designerFilePath, string clip, string parentId,
            int offsetX, int offsetY, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            return DesignerControlEditor.PasteControlAtOffset(src, clip, parentId, offsetX, offsetY);
        }

        /// <summary>Bring a control to front / send it to back by relocating its Controls.Add among its siblings.
        /// Pure text — no graph load. See <see cref="DesignerControlEditor.MoveZOrder"/>.</summary>
        public static ControlReorderResult MoveZOrder(string designerFilePath, string controlId, bool toFront, string? sourceText = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            string? ownershipError = CurrentSourceOwnershipError(src, controlId);
            if (ownershipError != null) return new ControlReorderResult { Safe = false, Reason = ownershipError };
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
            /// <summary>The resolved primary project output path. User assemblies are byte-loaded, so their
            /// Assembly.Location is empty; metadata policies that need a broker input path use this exact source.</summary>
            public string? ControlAssemblyPath { get; init; }
            /// <summary>Complete discoverable graph: host-sited current components plus inherited visual/field components.</summary>
            public required List<IComponent> GraphComponents { get; init; }
            /// <summary>Authoritative source ownership/editability for every <see cref="GraphComponents"/> entry.</summary>
            public required Dictionary<IComponent, ComponentOwnershipInfo> Ownership { get; init; }
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
        /// A small STA-local working set of live modern design surfaces. DesignSurface and every component it owns are
        /// apartment-affine, so ThreadStatic is intentional: production has one engine STA, while parallel test STAs
        /// must never exchange graphs. One current revision per document and four documents maximum mirrors the
        /// existing user-assembly cache's bounded working-set rule.
        /// </summary>
        private sealed class RetainedGraph
        {
            public required string Token { get; init; }
            public required string DesignerFilePath { get; init; }
            public required LoadedGraph Graph { get; init; }
            public required string SourceText { get; set; }
            public required List<LayoutControl> Controls { get; set; }
            public required int RenderScale { get; init; }
            public long Used { get; set; }
        }

        [ThreadStatic]
        private static Dictionary<string, RetainedGraph>? _retainedGraphs;
        [ThreadStatic]
        private static long _retainedGraphUse;
        private const int RetainedGraphLimit = 4;

        private static string RetainGraph(
            string designerFilePath,
            string sourceText,
            LoadedGraph graph,
            List<LayoutControl> controls,
            int renderScale)
        {
            var cache = _retainedGraphs ??= new Dictionary<string, RetainedGraph>(StringComparer.Ordinal);
            string canonicalPath = CanonicalDesignerPath(designerFilePath);
            foreach (string stale in cache.Values
                .Where(entry => string.Equals(entry.DesignerFilePath, canonicalPath, StringComparison.OrdinalIgnoreCase))
                .Select(entry => entry.Token)
                .ToArray())
                EvictRetainedGraph(stale);
            while (cache.Count >= RetainedGraphLimit)
            {
                var oldest = cache.Values.OrderBy(entry => entry.Used).First();
                EvictRetainedGraph(oldest.Token);
            }

            string token = Guid.NewGuid().ToString("N");
            cache[token] = new RetainedGraph
            {
                Token = token,
                DesignerFilePath = canonicalPath,
                Graph = graph,
                SourceText = sourceText,
                Controls = controls,
                RenderScale = Math.Max(1, renderScale),
                Used = ++_retainedGraphUse,
            };
            return token;
        }

        private static RetainedGraph? FindRetainedGraph(string token)
        {
            if (string.IsNullOrWhiteSpace(token) || _retainedGraphs == null
                || !_retainedGraphs.TryGetValue(token, out var entry)) return null;
            entry.Used = ++_retainedGraphUse;
            return entry;
        }

        /// <summary>
        /// Prove that an engine-issued live graph is the exact complete source revision a Lane B planner is about to
        /// edit. This only skips rebuilding the same IR: source hash/region/Lane A/minimality proofs still run normally.
        /// Must be called on the engine STA because the retained working set and DesignSurface are apartment-local.
        /// </summary>
        public static bool RetainedGraphProvesFullCoverage(
            string graphToken,
            string designerFilePath,
            string sourceText)
        {
            var entry = FindRetainedGraph(graphToken);
            return entry != null
                && string.Equals(entry.DesignerFilePath, CanonicalDesignerPath(designerFilePath), StringComparison.OrdinalIgnoreCase)
                && string.Equals(entry.SourceText, sourceText, StringComparison.Ordinal)
                && entry.Graph.Unrepresentable.Count == 0
                && entry.Graph.Total == entry.Graph.Representable;
        }

        private static void EvictRetainedGraph(string token)
        {
            if (_retainedGraphs == null || !_retainedGraphs.Remove(token, out var entry)) return;
            try { entry.Graph.Dispose(); } catch { /* the fallback rebuild remains authoritative */ }
        }

        private static string CanonicalDesignerPath(string path)
        {
            try { return Path.GetFullPath(path); }
            catch { return path; }
        }

        private static List<IComponent> SnapshotBaseGraph(IDesignerHost host, Control root)
        {
            var result = new List<IComponent>();
            var seen = new HashSet<IComponent>(ReferenceEqualityComparer.Instance);
            void Add(IComponent component)
            {
                if (!seen.Add(component)) return;
                result.Add(component);
                if (component is Control control)
                    foreach (Control child in control.Controls) Add(child);
                if (component is ToolStrip strip)
                    foreach (ToolStripItem item in strip.Items) AddToolStripItem(item);
            }
            void AddToolStripItem(ToolStripItem item)
            {
                Add(item);
                if (item is ToolStripDropDownItem dropDown && dropDown.HasDropDownItems)
                    foreach (ToolStripItem child in dropDown.DropDownItems) AddToolStripItem(child);
            }

            Add(root);
            foreach (IComponent component in host.Container.Components) Add(component);
            foreach (var component in ReflectedComponentFields(root).Keys) Add(component);
            return result;
        }

        private static Dictionary<IComponent, List<FieldInfo>> ReflectedComponentFields(Control root)
        {
            var fieldsByComponent = new Dictionary<IComponent, List<FieldInfo>>(ReferenceEqualityComparer.Instance);
            for (Type? type = root.GetType(); type != null && type != typeof(Form) && type != typeof(UserControl)
                 && type != typeof(Control) && type != typeof(Component); type = type.BaseType)
            {
                FieldInfo[] fields;
                try { fields = type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly); }
                catch { continue; }
                foreach (var field in fields)
                {
                    if (!typeof(IComponent).IsAssignableFrom(field.FieldType)) continue;
                    try
                    {
                        if (field.GetValue(root) is IComponent component)
                        {
                            if (!fieldsByComponent.TryGetValue(component, out var aliases))
                                fieldsByComponent[component] = aliases = new List<FieldInfo>();
                            aliases.Add(field);
                        }
                    }
                    catch { /* inaccessible/hostile field degrades to another identity source */ }
                }
            }
            return fieldsByComponent;
        }

        private static string EffectiveAccessibilityOf(FieldInfo field)
        {
            if (field.IsPublic) return "public";
            if (field.IsFamily) return "protected";
            if (field.IsFamilyOrAssembly) return "protected internal";
            if (field.IsFamilyAndAssembly) return "private protected";
            if (field.IsAssembly) return "internal";
            if (field.IsPrivate) return "private";
            return "unknown";
        }

        private static bool AccessibleFromDerivedDesigner(string accessibility) =>
            accessibility is "public" or "protected" or "protected internal";

        private static string BaseIdentityToken(FieldInfo field, string accessibility)
        {
            try
            {
                string identity = string.Join("\n", new[]
                {
                    field.DeclaringType?.Assembly.FullName ?? "",
                    field.Module.ModuleVersionId.ToString("D"),
                    field.DeclaringType?.FullName ?? "",
                    field.MetadataToken.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    field.Name,
                    field.FieldType.AssemblyQualifiedName ?? field.FieldType.FullName ?? field.FieldType.Name,
                    accessibility,
                });
                return "sha256:" + Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
            }
            catch { return ""; }
        }

        private static (List<IComponent> components, Dictionary<IComponent, ComponentOwnershipInfo> ownership) BuildGraphOwnership(
            IDesignerHost host, Control root, IReadOnlyList<IComponent> beforeInterpret, HashSet<string> sourceFields,
            string rootName, string baseTypeName, bool resolvedBase)
        {
            var components = new List<IComponent>();
            var seen = new HashSet<IComponent>(ReferenceEqualityComparer.Instance);
            void Add(IComponent component) { if (seen.Add(component)) components.Add(component); }
            foreach (IComponent component in host.Container.Components) Add(component);
            foreach (var component in beforeInterpret) Add(component);
            Add(root);

            var before = new HashSet<IComponent>(beforeInterpret, ReferenceEqualityComparer.Instance);
            var reflectedFields = ReflectedComponentFields(root);
            string Candidate(IComponent component)
            {
                string candidate = component.Site?.Name ?? "";
                if (candidate.Length == 0 && component is Control control) candidate = control.Name ?? "";
                if (candidate.Length == 0 && component is ToolStripItem item) candidate = item.Name ?? "";
                if (candidate.Length == 0 && reflectedFields.TryGetValue(component, out var fields) && fields.Count == 1)
                    candidate = fields[0].Name;
                return DesignerControlEditor.IsValidIdentifier(candidate ?? "") ? candidate! : "";
            }

            var candidates = components.Where(c => !ReferenceEquals(c, root))
                .GroupBy(Candidate, StringComparer.Ordinal)
                .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);
            var ownership = new Dictionary<IComponent, ComponentOwnershipInfo>(ReferenceEqualityComparer.Instance);
            int unresolvedOrdinal = 0;
            foreach (var component in components)
            {
                if (ReferenceEquals(component, root))
                {
                    ownership[component] = new ComponentOwnershipInfo
                    {
                        Id = "this", Name = rootName, Ownership = "root", Editable = true,
                    };
                    continue;
                }

                string candidate = Candidate(component);
                bool ambiguous = candidate.Length == 0 || candidates[candidate].Count != 1;
                if (ambiguous)
                {
                    string display = candidate.Length > 0 ? candidate : component.GetType().Name;
                    ownership[component] = new ComponentOwnershipInfo
                    {
                        Id = "unresolved:" + display + ":" + (++unresolvedOrdinal).ToString(System.Globalization.CultureInfo.InvariantCulture),
                        Name = display,
                        Ownership = "unresolved",
                        Editable = false,
                        ReadOnlyReason = candidate.Length == 0
                            ? "Component has no unique source-addressable identity."
                            : "More than one live component resolves to source id '" + candidate + "'.",
                    };
                    continue;
                }

                if (before.Contains(component))
                {
                    FieldInfo? field = null;
                    bool uniqueField = reflectedFields.TryGetValue(component, out var inheritedFields)
                        && inheritedFields.Count == 1;
                    if (uniqueField) field = inheritedFields![0];
                    string accessibility = field == null ? "unknown" : EffectiveAccessibilityOf(field);
                    bool resolvedControl = field != null && component is Control
                        && !field.IsStatic && field.Name == candidate
                        && typeof(Control).IsAssignableFrom(field.FieldType)
                        && field.FieldType.IsInstanceOfType(component)
                        && DesignerInheritedOverrideEditor.SupportsInheritedField(field.Name, field.FieldType, component.GetType());
                    bool overrideEditable = resolvedBase && uniqueField && resolvedControl
                        && AccessibleFromDerivedDesigner(accessibility);
                    string token = overrideEditable ? BaseIdentityToken(field!, accessibility) : "";
                    overrideEditable = overrideEditable && token.Length > 0;
                    bool geometryOverrideEditable = overrideEditable && component is Control inheritedControl
                        && inheritedControl.Dock == DockStyle.None
                        && !inheritedControl.AutoSize
                        && DesignerGeometry.LiveRefusalReason(inheritedControl, root).Length == 0;
                    ownership[component] = new ComponentOwnershipInfo
                    {
                        Id = candidate,
                        Name = candidate,
                        Ownership = "inherited",
                        Editable = false,
                        InheritedPropertyOverrideEditable = overrideEditable,
                        InheritedGeometryOverrideEditable = geometryOverrideEditable,
                        BaseIdentityToken = token,
                        InheritedFieldType = field?.FieldType.FullName ?? "",
                        EffectiveAccessibility = accessibility,
                        InheritedResolvedFieldType = overrideEditable ? field?.FieldType : null,
                        ReadOnlyReason = overrideEditable
                            ? "Component belongs to inherited base type '" + (baseTypeName.Length > 0 ? baseTypeName : root.GetType().Name)
                                + "'. Structural edits remain read-only; allowlisted properties may be overridden in the derived source."
                            : !uniqueField
                                ? "Inherited component does not map to exactly one base field."
                                : !AccessibleFromDerivedDesigner(accessibility)
                                    ? "Inherited field is not public or protected; derived overrides are read-only."
                                    : "Inherited component type or base identity is not trusted for derived overrides.",
                    };
                }
                else if (sourceFields.Contains(candidate))
                {
                    ownership[component] = new ComponentOwnershipInfo
                    {
                        Id = candidate, Name = candidate, Ownership = "currentSource", Editable = true,
                    };
                }
                else
                {
                    ownership[component] = new ComponentOwnershipInfo
                    {
                        Id = candidate,
                        Name = candidate,
                        Ownership = "unresolved",
                        Editable = false,
                        ReadOnlyReason = "Component is not declared by the current designer source and is not a resolved base component.",
                    };
                }
            }
            return (components, ownership);
        }

        /// <summary>
        /// Resolve the control assembly (explicit path → project auto-discovery), build a
        /// DesignSurface for the detected root type, and interpret the representable
        /// InitializeComponent subset into a live graph. Shared by render and serialize.
        /// </summary>
        // ---- the user's compiled graph: loaded WITHOUT pinning their build output, and reused across renders ----
        //
        // Two problems used to live in the block this replaces, both invisible until a user tried to rebuild:
        //   • it loaded with LoadFromAssemblyPath, which holds an OS handle on every file until the context is
        //     collected — so an open designer made the user's own build fail with MSB3027 ("the file is locked by
        //     WinFormsDesigner.Engine"), for a .NET FRAMEWORK output too: that load SUCCEEDS here (only the types
        //     fail to resolve), so a net48 project got its .exe pinned by the engine that can never render it.
        //   • it built a FRESH ControlLoadContext on every LoadGraph — i.e. on every render, describe, serialize and
        //     preview-save — and never unloaded any of them, so the whole output directory was re-mapped and leaked
        //     per call.
        // Now: no-lock (byte) loading, and one context per output, rebuilt only when that output actually changes —
        // the same "reload when the build changes" rule the net48 engine's DomainManager uses for its child domains.
        private static readonly object _userAsmLock = new();
        private static readonly Dictionary<string, (long stamp, ControlLoadContext alc, List<Assembly> asms, long used)> _userAsmCache
            = new(StringComparer.OrdinalIgnoreCase);
        private static long _userAsmUse;
        /// <summary>Distinct output directories kept loaded. Small on purpose: it exists to stop per-render reloads,
        /// not to be a general cache — a user has one or two projects open at a time, and every extra entry keeps a
        /// whole assembly graph in memory.</summary>
        private const int UserAsmCacheLimit = 4;

        /// <summary>
        /// The user's resolved output plus its sibling (non-shared) assemblies, loaded into one collectible context
        /// that takes NO handle on any of those files (see <see cref="ControlLoadContext.LoadNoLock"/>).
        ///
        /// Cached per output path and rebuilt when <see cref="OutputStamp"/> changes, so a rebuild is picked up on the
        /// next render but an unchanged build is not re-read. Returns a COPY of the assembly list: callers own theirs
        /// (the load-failure path clears it) and must not mutate the cached one.
        ///
        /// An unloadable resolved assembly (wrong runtime/bitness, corrupt PE) must not abort the whole render, so any
        /// failure degrades to an empty list — a framework-only render, exactly as if nothing had resolved.
        /// </summary>
        private static List<Assembly> LoadUserAssemblies(string? asmPath)
        {
            if (string.IsNullOrEmpty(asmPath) || !File.Exists(asmPath)) return new List<Assembly>();
            string full;
            try { full = Path.GetFullPath(asmPath); } catch { return new List<Assembly>(); }
            long stamp = OutputStamp(full);

            lock (_userAsmLock)
            {
                if (_userAsmCache.TryGetValue(full, out var hit))
                {
                    if (hit.stamp == stamp)
                    {
                        _userAsmCache[full] = (hit.stamp, hit.alc, hit.asms, ++_userAsmUse);
                        return new List<Assembly>(hit.asms);
                    }
                    // Rebuilt since we loaded it → this graph is stale. Drop it and load the new one.
                    _userAsmCache.Remove(full);
                    TryUnload(hit.alc);
                }

                var loaded = new List<Assembly>();
                ControlLoadContext? alc = null;
                try
                {
                    alc = new ControlLoadContext(full);
                    loaded.Add(alc.LoadNoLock(full));
                    // also load sibling (non-shared) assemblies so types across the project resolve
                    string? outDir = Path.GetDirectoryName(full);
                    if (outDir != null)
                    {
                        foreach (var dll in Directory.GetFiles(outDir, "*.dll"))
                        {
                            if (string.Equals(dll, full, StringComparison.OrdinalIgnoreCase)) continue;
                            if (ControlLoadContext.IsSharedName(Path.GetFileNameWithoutExtension(dll))) continue;
                            try { loaded.Add(alc.LoadNoLock(dll)); } catch { /* skip non-loadable */ }
                        }
                    }
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[engine] could not load resolved assembly {full}: {ex.GetType().Name}: {ex.Message}");
                    if (alc != null) TryUnload(alc);
                    return new List<Assembly>();
                }

                while (_userAsmCache.Count >= UserAsmCacheLimit)
                {
                    string? oldest = null; long oldestUse = long.MaxValue;
                    foreach (var kv in _userAsmCache)
                        if (kv.Value.used < oldestUse) { oldestUse = kv.Value.used; oldest = kv.Key; }
                    if (oldest == null) break;
                    TryUnload(_userAsmCache[oldest].alc);
                    _userAsmCache.Remove(oldest);
                }
                _userAsmCache[full] = (stamp, alc!, loaded, ++_userAsmUse);
                return new List<Assembly>(loaded);
            }
        }

        /// <summary>Unload a superseded context. Best-effort by nature: Unload only STARTS the unload, and a context
        /// whose types reached a DesignSurface/TypeDescriptor may never be collected. That is a memory question only —
        /// the user's FILES were never held (byte-loaded), which is what a rebuild cares about.</summary>
        private static void TryUnload(ControlLoadContext alc)
        {
            try { alc.Unload(); } catch { /* already unloading / not collectible — nothing else to do */ }
        }

        /// <summary>Cheap fingerprint of a resolved output: the assembly's own write time AND length, the newest write
        /// time across the sibling dlls loaded with it, and the dll count. Rebuilding ANY project in the output
        /// directory moves it (a referenced library can be rebuilt while the host assembly is untouched), a REMOVED
        /// dll moves the count even when no timestamp advanced, and the length catches a restored/copied build whose
        /// timestamp went BACKWARDS — the case a newest-time-only stamp would read as unchanged.</summary>
        private static long OutputStamp(string full)
        {
            long own = 0;
            try
            {
                var info = new FileInfo(full);
                own = unchecked(info.LastWriteTimeUtc.Ticks * 31 + info.Length);
            }
            catch { /* unreadable → 0, still a stable stamp */ }

            long siblingNewest = 0;
            int siblingCount = 0;
            string? outDir = Path.GetDirectoryName(full);
            if (outDir != null)
            {
                try
                {
                    foreach (var dll in Directory.EnumerateFiles(outDir, "*.dll"))
                    {
                        siblingCount++;
                        long t;
                        try { t = File.GetLastWriteTimeUtc(dll).Ticks; } catch { continue; }
                        if (t > siblingNewest) siblingNewest = t;
                    }
                }
                catch { /* unreadable directory → the assembly's own stamp still stands */ }
            }
            return unchecked((own * 31 + siblingNewest) * 31 + siblingCount);
        }

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

            var userAsms = LoadUserAssemblies(asmPath);

            var rootInfo = DetectRootType(cls, designerFilePath, userAsms);
            Type rootType = rootInfo.Surface;

            DesignSurface surface = new DesignSurface();
            try
            {
                try { surface.BeginLoad(rootType); }
                catch when (rootInfo.ResolvedBase)
                {
                    // A compiled base can still be non-designable (throwing constructor, missing runtime dependency,
                    // unsupported designer). Dispose the partial surface and preserve the historical framework-only
                    // preview, but mark it incomplete/read-only instead of pretending the base graph resolved.
                    surface.Dispose();
                    rootType = SurfaceFor(rootType);
                    rootInfo = new RootTypeInfo(rootType, true, rootInfo.BaseTypeName, false);
                    surface = new DesignSurface();
                    surface.BeginLoad(rootType);
                }
                if (!surface.IsLoaded)
                {
                    throw new InvalidOperationException("DesignSurface failed to load root " + rootType.FullName);
                }
                var host = (IDesignerHost)surface.GetService(typeof(IDesignerHost))!;
                var beforeInterpret = SnapshotBaseGraph(host, (Control)host.RootComponent);
                // resolve resources.GetObject(...) against the form's sibling .resx (image/icon properties).
                // null when there is no .resx → forms without resources are entirely unaffected.
                var resx = ResxResolver.TryLoadForDesigner(designerFilePath);
                var (total, ok, unrep, explicitMembers, eventWirings, supportInit) = Interpret(
                    cls, host, userAsms, resx, SeedInheritedOverrideComponents((Control)host.RootComponent, beforeInterpret));
                var graph = BuildGraphOwnership(host, (Control)host.RootComponent, beforeInterpret,
                    FormClassResolver.FieldNamesOf(cls), cls.Identifier.Text, rootInfo.BaseTypeName, rootInfo.ResolvedBase);

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
                    ControlAssemblyPath = string.IsNullOrWhiteSpace(asmPath) ? null : Path.GetFullPath(asmPath),
                    GraphComponents = graph.components,
                    Ownership = graph.ownership,
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
            var asm = alc.LoadNoLock(full);
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
        private readonly record struct RootTypeInfo(Type Surface, bool InheritedBase, string BaseTypeName, bool ResolvedBase);

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
                        bool sourceAgreesWithCompiledBase = syn == null
                            || (synInherited && BaseNameMatches(syn.Value.BaseTypeName, baseT));
                        if (!reflResolved && sourceAgreesWithCompiledBase && CanLoadResolvedBase(baseT))
                            return new RootTypeInfo(baseT!, false, baseT!.FullName ?? baseT.Name, true);
                        // FAIL-CLOSED UNION: flag if EITHER the compiled base OR the current source base is non-framework.
                        // Reflection ALONE false-resolves against a STALE build (source added inheritance but wasn't
                        // rebuilt) while the source-interpreted render already drops the base's controls. When
                        // reflection resolves but the source flags, prefer the source's base name (the reflected base is
                        // the stale framework root; the source names the real new base).
                        bool inherited = !reflResolved || synInherited;
                        string baseName = !inherited ? ""
                            : !reflResolved ? (baseT?.FullName ?? baseT?.Name ?? "unknown")
                            : (syn?.BaseTypeName ?? "unknown");
                        return new RootTypeInfo(SurfaceFor(compiled), inherited, baseName, false);
                    }
                }
                catch { /* reflection hiccup → fall through to the syntactic result (fail-closed) */ }
            }

            // Buildless / type not found: the syntactic result, or today's default (Form, no banner) when there is no
            // base evidence anywhere (unreadable sibling + no build) — positive-evidence keeps plain forms un-bannered.
            return syn ?? new RootTypeInfo(typeof(Form), false, "", false);
        }

        private static bool BaseNameMatches(string sourceName, Type? reflectedBase)
        {
            if (reflectedBase == null || string.IsNullOrWhiteSpace(sourceName)) return false;
            string reflectedName = reflectedBase.Name;
            int tick = reflectedName.IndexOf('`');
            if (tick >= 0) reflectedName = reflectedName.Substring(0, tick);
            return string.Equals(sourceName, reflectedName, StringComparison.Ordinal)
                || string.Equals(sourceName, reflectedBase.FullName, StringComparison.Ordinal)
                || (reflectedBase.FullName?.EndsWith("." + sourceName, StringComparison.Ordinal) ?? false);
        }

        private static bool CanLoadResolvedBase(Type? baseType)
        {
            if (baseType == null || baseType.IsAbstract || baseType.ContainsGenericParameters
                || !typeof(Control).IsAssignableFrom(baseType)) return false;
            return baseType.GetConstructor(BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null) != null;
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
            if (simple == "Form" || full == "System.Windows.Forms.Form") return new RootTypeInfo(typeof(Form), false, "", false);
            if (simple == "UserControl" || full == "System.Windows.Forms.UserControl") return new RootTypeInfo(typeof(UserControl), false, "", false);
            Type surface = simple.Contains("UserControl") ? typeof(UserControl) : typeof(Form);
            return new RootTypeInfo(surface, true, simple, false);
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
                var componentPath = Flatten(lhs.Expression);
                string comp = lhs.Expression is ThisExpressionSyntax
                    ? "this"
                    : componentPath.Count > 0 && componentPath.All(DesignerControlEditor.IsValidIdentifier)
                        ? string.Join(".", componentPath)
                        : "";
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

        private static Dictionary<string, IComponent> SeedInheritedOverrideComponents(
            Control root, IReadOnlyList<IComponent> beforeInterpret)
        {
            var before = new HashSet<IComponent>(beforeInterpret, ReferenceEqualityComparer.Instance);
            var candidates = new List<(string name, IComponent component)>();
            foreach (var kv in ReflectedComponentFields(root))
            {
                if (!before.Contains(kv.Key) || kv.Value.Count != 1 || kv.Key is not Control control) continue;
                var field = kv.Value[0];
                string accessibility = EffectiveAccessibilityOf(field);
                if (field.IsStatic || !AccessibleFromDerivedDesigner(accessibility)
                    || !DesignerControlEditor.IsValidIdentifier(field.Name)
                    || !typeof(Control).IsAssignableFrom(field.FieldType)
                    || !field.FieldType.IsInstanceOfType(control)
                    || !DesignerInheritedOverrideEditor.SupportsInheritedField(field.Name, field.FieldType, control.GetType())) continue;
                candidates.Add((field.Name, kv.Key));
            }
            return candidates.GroupBy(candidate => candidate.name, StringComparer.Ordinal)
                .Where(group => group.Count() == 1)
                .ToDictionary(group => group.Key, group => group.Single().component, StringComparer.Ordinal);
        }

        private static (int total, int ok, List<string> unrep, HashSet<(IComponent, string)> explicitMembers, List<string> eventWirings, List<string> supportInit) Interpret(
            ClassDeclarationSyntax cls, IDesignerHost host, IReadOnlyList<Assembly> userAsms, ResxResolver? resx = null,
            IReadOnlyDictionary<string, IComponent>? inheritedOverrideComponents = null)
        {
            var root = (Control)host.RootComponent;
            var comps = new Dictionary<string, IComponent>(StringComparer.Ordinal);
            if (inheritedOverrideComponents != null)
                foreach (var candidate in inheritedOverrideComponents)
                    comps[candidate.Key] = candidate.Value;
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
                    && (LastTypeSegment(lds.Declaration.Type.ToString()).TrimEnd('?') == "ComponentResourceManager"
                        || lds.Declaration.Variables.Any(v => v.Initializer?.Value is ObjectCreationExpressionSyntax oce
                            && LastTypeSegment(oce.Type.ToString()) == "ComponentResourceManager")))
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

        private static bool TryResolveApplyResourcesTarget(ExpressionSyntax expr, Control root,
            Dictionary<string, IComponent> comps, out object target)
        {
            target = root;
            if (expr is ThisExpressionSyntax) return true;
            var chain = Flatten(expr);
            if (chain.Count == 1 && comps.TryGetValue(chain[0], out var component))
            {
                target = component;
                return true;
            }
            return false;
        }

        private static IComponent? FindGraphComponent(LoadedGraph g, string id)
        {
            if (id is "this" or "") return g.Host.RootComponent;
            if (string.IsNullOrWhiteSpace(id)) return null;
            foreach (var component in g.GraphComponents)
                if (g.Ownership.TryGetValue(component, out var source)
                    && string.Equals(source.Id, id, StringComparison.Ordinal)) return component;
            int separator = id.LastIndexOf('.');
            if (separator > 0 && separator < id.Length - 1)
            {
                string splitId = id.Substring(0, separator);
                string panelName = id.Substring(separator + 1);
                if (panelName is "Panel1" or "Panel2"
                    && FindGraphComponent(g, splitId) is SplitContainer split)
                    return panelName == "Panel1" ? split.Panel1 : split.Panel2;
            }
            return null;
        }

        private static Control? FindGraphControl(LoadedGraph g, string id) => FindGraphComponent(g, id) as Control;

        /// <summary>Apply bounded, request-local tab view state. Only exact identities in the loaded graph are used,
        /// and only a standard TabControl -> member TabPage relation may be mutated. Invalid entries are ignored.</summary>
        private static void ApplyTabViewState(LoadedGraph g, string[]? selectedTabs)
        {
            if (selectedTabs == null) return;
            for (int i = 0; i < selectedTabs.Length && i < 128; i++)
            {
                var entry = selectedTabs[i];
                if (string.IsNullOrEmpty(entry) || entry.Length > 513) continue;
                int separator = entry.IndexOf('=');
                if (separator <= 0 || separator != entry.LastIndexOf('=') || separator > 256
                    || entry.Length - separator - 1 > 256) continue;
                var hostId = entry[..separator];
                var pageId = entry[(separator + 1)..];
                if (FindGraphControl(g, hostId) is not TabControl host
                    || FindGraphControl(g, pageId) is not TabPage page
                    || !host.TabPages.Contains(page)) continue;
                try { host.SelectedTab = page; }
                catch { /* a custom TabControl subclass may reject selection; retain source-selected state */ }
            }
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

            if (method is "BringToFront" or "SendToBack")
            {
                if ((inv.ArgumentList?.Arguments.Count ?? 0) != 0)
                {
                    why = method + " unexpected arguments: " + inv.ToString().Trim();
                    return false;
                }

                Control? targetControl = null;
                if (targetChain.Count == 0)
                    targetControl = root;
                else if (targetChain.Count == 1 && comps.TryGetValue(targetChain[0], out var targetComponent) && targetComponent is Control resolved)
                    targetControl = resolved;

                if (targetControl == null)
                {
                    why = method + " on unknown control: " + ma.Expression;
                    return false;
                }

                if (method == "BringToFront") targetControl.BringToFront();
                else targetControl.SendToBack();
                return true;
            }

            if (method == "ApplyResources"
                && _resx is { } rx
                && rx.vars.Contains(targetChain.Count == 1 ? targetChain[0] : "")
                && (inv.ArgumentList?.Arguments.Count ?? 0) == 2
                && inv.ArgumentList is { } applyArgs
                && TryResolveApplyResourcesTarget(applyArgs.Arguments[0].Expression, root, comps, out var resourceTarget)
                && applyArgs.Arguments[1].Expression is LiteralExpressionSyntax keyLiteral
                && keyLiteral.IsKind(SyntaxKind.StringLiteralExpression))
            {
                if (rx.resolver == null || rx.resolver.ApplyResources(resourceTarget, keyLiteral.Token.ValueText))
                    return true;
                why = "ApplyResources refused unsafe or incompatible resources: " + inv.ToString().Trim();
                return false;
            }

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

                if (inv.ArgumentList == null) { why = "Controls.Add with no arguments: " + inv.ToString().Trim(); return false; }
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
                            else
                            {
                                // Controls.AddRange losing an element is categorically different from a list/menu
                                // collection losing an item: it removes a declared control from the design surface.
                                // Preserve that distinction so every render/save host can fail closed.
                                why = (targetChain.Count > 0 && targetChain[^1] == "Controls"
                                    ? "Controls.AddRange unknown element "
                                    : "AddRange: unknown element ") + elExpr;
                                return false;
                            }
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

                        // Real VS-generated Image assignments may use
                        // `System.Drawing.SystemIcons.Information.ToBitmap()`. This is the one allowlisted instance
                        // invocation: a zero-argument conversion of a finite, trusted framework icon property. It is
                        // recognized before generic static-factory resolution because the receiver includes the icon
                        // member and is therefore not itself a type name.
                        if (mai.Name.Identifier.Text == "ToBitmap" && invk.ArgumentList.Arguments.Count == 0
                            && mai.Expression is MemberAccessExpressionSyntax iconRead)
                        {
                            string iconTypeName = iconRead.Expression.ToString();
                            string iconMember = iconRead.Name.Identifier.Text;
                            if (DesignerAllowlists.TryGetSystemIconBitmapFactoryName(iconTypeName, iconMember, out string iconFactory))
                            {
                                var iconType = ResolveType(iconTypeName, userAsms)
                                    ?? throw new InvalidOperationException("cannot resolve system icon type " + iconTypeName);
                                if (!DesignerAllowlists.TryGetSystemIconBitmapMember(iconType, iconFactory, out string checkedMember))
                                    throw new InvalidOperationException("system icon bitmap factory not allowed: " + iconTypeName + "." + iconMember);
                                var iconProperty = iconType.GetProperty(checkedMember, BindingFlags.Public | BindingFlags.Static);
                                if (iconProperty?.GetValue(null) is Icon icon) return icon.ToBitmap();
                                throw new InvalidOperationException("no system icon member " + checkedMember);
                            }
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
