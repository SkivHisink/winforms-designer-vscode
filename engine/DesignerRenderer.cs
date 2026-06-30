using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
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
    /// (Phase 1, §8.3) so real custom controls render with full fidelity.
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
        private static byte[] CaptureRootPng(Control root, int w, int h)
        {
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
            };
        }

        /// <summary>
        /// Render the full frame to PNG AND build the click-to-select hit-test map from ONE graph load —
        /// the combined <see cref="RenderDetailed"/> + <see cref="DescribeLayout"/> the unified designer's
        /// full render needs together. Issued as two RPCs, render and layout each re-parsed, re-interpreted
        /// and rebuilt the graph (the dominant cost on large forms); folding them halves that work. The
        /// returned Png/Width/Height and Controls are byte/field-identical to the two separate calls.
        /// </summary>
        public static RenderLayoutResult RenderWithLayout(string designerFilePath, string? controlAssemblyPath = null, string? sourceText = null)
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
            var png = CaptureRootPng(root, w, h);

            return new RenderLayoutResult
            {
                Png = png,
                Width = w,
                Height = h,
                ClientWidth = root.ClientSize.Width,
                ClientHeight = root.ClientSize.Height,
                RootType = g.RootType.FullName ?? g.RootType.Name,
                TotalStatements = g.Total,
                Representable = g.Representable,
                Unrepresentable = g.Unrepresentable,
                Controls = controls,
                Tray = BuildTray(g, root),
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

        /// <summary>
        /// The component tray (§7.3): every host-container component that is NOT a Control — Timer, ToolTip,
        /// ErrorProvider, ImageList, BindingSource, etc. ANY Control (parented or orphaned) belongs to the
        /// visual layout/hit-test map (BuildLayoutControls), NOT the tray, so the two read-paths never
        /// double-list the same component. The root form and the (unnamed) IContainer disposal holder are
        /// excluded. Pure reads; the host owns lifetime, so this never instantiates anything new.
        /// </summary>
        private static List<TrayComponent> BuildTray(LoadedGraph g, Control root)
        {
            var tray = new List<TrayComponent>();
            foreach (IComponent comp in g.Host.Container.Components)
            {
                if (ReferenceEquals(comp, root)) continue;
                if (comp is Control) continue;                // a Control lives in the visual layout, never the tray
                string id = comp.Site?.Name ?? "";
                if (id.Length == 0) continue;                 // unnamed/internal (e.g. the IContainer holder) → skip
                tray.Add(new TrayComponent { Id = id, Name = id, Type = comp.GetType().FullName ?? comp.GetType().Name });
            }
            tray.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return tray;
        }

        /// <summary>
        /// Load a .Designer.cs into a live design surface and serialize it back to
        /// InitializeComponent through the host serializer with §6.3 default-value
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
                r = DesignerSerializer.Serialize(g.Surface, g.Host, g.ClassName, normalizeDefaults, g.ExplicitMembers);
            }
            catch (Exception ex)
            {
                // Some controls can LOAD/RENDER but cannot be CodeDom-serialized on .NET 9: the host
                // serializer pulls BinaryFormatter-backed resources (e.g. ToolStrip/MenuStrip), and
                // BinaryFormatter was removed in .NET 9 → "This platform does not support binary serialized
                // resources." The form still renders and accepts targeted text edits (--set-prop never
                // serializes); only the full normalize-save is impossible. Degrade to the §6.5 read-only
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
            // carry interpret stats so the caller can enforce the §6.5 read-only fallback
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
        /// back into the existing file (save-direction, §6.3/§6.6). The result is a preview:
        /// the caller decides whether to write it. <see cref="SaveResult.Safe"/> is true only
        /// when the source fully round-trips (§6.5) — never write back otherwise.
        /// </summary>
        public static SaveResult SaveSplice(string designerFilePath, string? controlAssemblyPath = null)
        {
            var (encoding, original) = ReadWithEncoding(designerFilePath);
            var rt = SerializeFromFile(designerFilePath, controlAssemblyPath);
            if (!rt.RoundTripSafe)
            {
                return new SaveResult { RoundTrip = rt, OriginalText = original, Encoding = encoding, SplicedText = null };
            }
            // plan §6.5 statement-level diff: refuse to save if re-serialization fails to reproduce
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
            return DesignerDescribe.Describe(g.Host, g.ClassName, g.ExplicitMembers, g.Total, g.Representable, g.Unrepresentable, g.EventWirings);
        }

        /// <summary>Describe one component by edit id ("this" = root) — the bounded per-selection path for a grid.</summary>
        public static ComponentInfo? DescribeComponent(string designerFilePath, string componentId, string? controlAssemblyPath = null, string? sourceText = null)
        {
            using var g = LoadGraph(designerFilePath, controlAssemblyPath, sourceText);
            return DesignerDescribe.DescribeComponent(g.Host, g.ClassName, g.ExplicitMembers, componentId, g.EventWirings);
        }

        /// <summary>
        /// Apply a targeted single-property edit to a source file (byte-minimal text edit, §6.3
        /// sentinel). Verifies the result still parses and that ONLY the target (component,
        /// property) changed (§6.5 for edits). Returns a preview — the caller decides to write.
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
                bool needsStub = codeText != null && !DesignerEventEditor.HasMethod(codeText, g.ClassName, existing);
                if (!needsStub)
                    return new EventGenResult { Safe = true, AlreadyWired = true, HandlerName = existing };
                var s0 = MakeStub(codeText!, g.ClassName, existing, invoke);
                return new EventGenResult
                {
                    Safe = s0.Ok, Reason = s0.Reason, AlreadyWired = true, HandlerName = existing,
                    CodeText = s0.NewText, StubCreated = s0.Ok,
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
            string delegateFqn = CSharpType(del);
            var wire = DesignerEventEditor.WireEvent(designerSrc, idKey, eventName, delegateFqn, handler);
            if (wire.Mode == EditMode.Failed)
                return new EventGenResult { Safe = false, Reason = wire.Reason, HandlerName = handler };

            bool parseOk = !CSharpSyntaxTree.ParseText(wire.NewText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool wiringOk = DesignerEventEditor.OnlyWiringAdded(designerSrc, wire.NewText, idKey, eventName);
            if (!parseOk || !wiringOk)
                return new EventGenResult { Safe = false, HandlerName = handler, Reason = !parseOk ? "wired text has syntax errors" : "wiring changed more than the target event" };

            string? newCode = null;
            bool stubCreated = false;
            if (!DesignerEventEditor.HasMethod(codeText, g.ClassName, handler))
            {
                var stub = MakeStub(codeText, g.ClassName, handler, invoke);
                if (!stub.Ok)
                    return new EventGenResult { Safe = false, HandlerName = handler, Reason = "stub: " + stub.Reason };
                newCode = stub.NewText;
                stubCreated = true;
            }

            return new EventGenResult
            {
                Safe = true, HandlerName = handler, AlreadyWired = false,
                DesignerText = wire.NewText, CodeText = newCode, StubCreated = stubCreated,
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
                var pnames = invoke.GetParameters().Select(p => p.ParameterType.Name).ToList();
                bool isVoid = invoke.ReturnType == typeof(void);
                string sig = (isVoid ? "v:" : "r:") + string.Join(",", pnames);
                if (!bySig.TryGetValue(sig, out var cands))
                {
                    cands = DesignerEventEditor.FindCompatibleHandlers(codeText, g.ClassName, pnames, isVoid);
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
            // wiring to a method that doesn't exist in the code-behind would not compile — refuse it.
            if (handler != null && codeText != null && !DesignerEventEditor.HasMethod(codeText, g.ClassName, handler))
                return new EventWiringResult { Safe = false, Reason = "handler method not found in code-behind: " + handler };

            int delta = handler == null ? -1 : (wired ? 0 : 1);
            string src = designerSourceText ?? File.ReadAllText(designerFilePath);
            string delegateFqn = CSharpType(del);
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
        public static ControlAddResult AddControl(string designerFilePath, string parentId, string controlTypeKey, string? sourceText = null, int? locX = null, int? locY = null, string? controlAssemblyPath = null)
        {
            string src = sourceText ?? File.ReadAllText(designerFilePath);
            // Fast path (curated/framework): pure text, NO assembly load. Only a project-control key (§7.2
            // Increment 2) needs the project assembly enumerated to validate + resolve its full type name.
            IReadOnlyList<ToolboxItemInfo>? projectControls = null;
            if (!DesignerControlEditor.CanResolveWithoutProject(controlTypeKey))
            {
                projectControls = EnumerateProjectControls(ResolveAsmForList(designerFilePath, controlAssemblyPath));
            }
            return DesignerControlEditor.AddControl(src, parentId, controlTypeKey, projectControls, locX, locY);
        }

        /// <summary>The toolbox's available control type keys (e.g. "Button", "Label", …).</summary>
        public static IReadOnlyList<string> ControlTypes() => DesignerControlEditor.ControlTypes;

        /// <summary>The auto-populated toolbox palette (§7.2): framework controls always, plus the resolved
        /// project assembly's own controls (§7.2 Increment 2, category "Project Controls") when a designer file is
        /// given. Framework discovery is pure reflection; project enumeration loads the assembly in a collectible
        /// ALC (cached per file mtime), reflects type names only (§9 reload-safe), and never instantiates.</summary>
        public static IReadOnlyList<ToolboxItemInfo> ToolboxItems(string? designerFilePath = null, string? controlAssemblyPath = null)
        {
            var items = new List<ToolboxItemInfo>(DesignerControlEditor.ToolboxItems);
            if (!string.IsNullOrEmpty(designerFilePath) || !string.IsNullOrEmpty(controlAssemblyPath))
            {
                items.AddRange(EnumerateProjectControls(ResolveAsmForList(designerFilePath, controlAssemblyPath)));
            }
            return items;
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

        /// <summary>Enumerate the project assembly's own toolbox-eligible controls (§7.2 Increment 2). Loads the
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
                parms.Add((CSharpType(p.ParameterType), n));
            }
            return DesignerEventEditor.GenerateHandlerStub(code, formClass, handler, CSharpType(invoke.ReturnType), parms);
        }

        /// <summary>C# name for a type, valid in a method signature without extra using directives: keyword for
        /// common built-ins, '.' for nested types (FullName uses '+'), and reconstructed Name&lt;Args&gt; for
        /// generics (FullName carries a grave-accent arity marker that isn't valid C#).</summary>
        private static string CSharpType(Type t)
        {
            if (t == typeof(void)) return "void";
            if (t == typeof(object)) return "object";
            if (t == typeof(string)) return "string";
            if (t == typeof(bool)) return "bool";
            if (t == typeof(int)) return "int";
            if (t == typeof(long)) return "long";
            if (t == typeof(double)) return "double";
            if (t == typeof(float)) return "float";
            if (t.IsArray) return CSharpType(t.GetElementType()!) + "[]";
            if (t.IsGenericType)
            {
                string baseName = t.GetGenericTypeDefinition().FullName ?? t.Name;
                int tick = baseName.IndexOf('`');
                if (tick >= 0) baseName = baseName.Substring(0, tick);
                baseName = baseName.Replace('+', '.');
                return baseName + "<" + string.Join(", ", t.GetGenericArguments().Select(CSharpType)) + ">";
            }
            return (t.FullName ?? t.Name).Replace('+', '.');
        }

        /// <summary>
        /// Read a source file preserving its on-disk encoding/BOM so a save can write it back
        /// byte-faithfully (codex finding: default WriteAllText strips a UTF-8 BOM that real
        /// VS designer files carry → whole-file churn). Handles UTF-8 ±BOM and UTF-16 LE/BE.
        /// </summary>
        private static (Encoding encoding, string text) ReadWithEncoding(string path)
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
            public required string ClassName { get; init; }
            public required List<Assembly> UserAsms { get; init; }
            public int Total { get; init; }
            public int Representable { get; init; }
            public required List<string> Unrepresentable { get; init; }
            public required HashSet<(IComponent, string)> ExplicitMembers { get; init; }
            /// <summary>Event wirings parsed from the source: component id ("this"/Site.Name) → (event → handler method).</summary>
            public required Dictionary<string, Dictionary<string, string>> EventWirings { get; init; }
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
            var cls = rootNode.DescendantNodes().OfType<ClassDeclarationSyntax>().First();

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

            Type rootType = DetectRootType(cls);

            var surface = new DesignSurface();
            try
            {
                surface.BeginLoad(rootType);
                if (!surface.IsLoaded)
                {
                    throw new InvalidOperationException("DesignSurface failed to load root " + rootType.FullName);
                }
                var host = (IDesignerHost)surface.GetService(typeof(IDesignerHost))!;
                var (total, ok, unrep, explicitMembers) = Interpret(cls, host, userAsms);

                return new LoadedGraph
                {
                    Surface = surface,
                    Host = host,
                    RootType = rootType,
                    ClassName = cls.Identifier.Text,
                    UserAsms = userAsms,
                    Total = total,
                    Representable = ok,
                    Unrepresentable = unrep,
                    ExplicitMembers = explicitMembers,
                    EventWirings = ExtractEventWirings(cls),
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
        /// Proves real custom-control rendering (plan §8.3) — not a placeholder.
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

        private static Type DetectRootType(ClassDeclarationSyntax cls)
        {
            if (cls.BaseList != null)
            {
                string bases = cls.BaseList.ToString();
                if (bases.Contains("UserControl")) return typeof(UserControl);
                if (bases.Contains("Form")) return typeof(Form);
            }
            return typeof(Form);
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
            var init = cls.Members.OfType<MethodDeclarationSyntax>()
                .FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
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

        private static (int total, int ok, List<string> unrep, HashSet<(IComponent, string)> explicitMembers) Interpret(
            ClassDeclarationSyntax cls, IDesignerHost host, IReadOnlyList<Assembly> userAsms)
        {
            var root = (Control)host.RootComponent;
            var comps = new Dictionary<string, IComponent>(StringComparer.Ordinal);
            var unrep = new List<string>();
            // (component, property) pairs explicitly assigned in the source file. Lets the
            // serializer echo exactly the source's property set (§6.3) and not the extra
            // state the live designer/runtime assigns on its own (auto TabIndex, CheckState…).
            var explicitMembers = new HashSet<(IComponent, string)>();
            int total = 0, ok = 0;

            // names of `IContainer components = new Container()` fields — lets a provider ctor
            // `new ToolTip(this.components)` be recognized (extenders) without opening general ctor-args.
            var containerNames = new HashSet<string>(StringComparer.Ordinal);

            var fieldNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
            {
                foreach (var v in f.Declaration.Variables)
                {
                    fieldNames.Add(v.Identifier.Text);
                }
            }

            var init = cls.Members.OfType<MethodDeclarationSyntax>()
                .FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (init?.Body == null)
            {
                unrep.Add("InitializeComponent not found");
                return (0, 0, unrep, explicitMembers);
            }

            foreach (var stmt in init.Body.Statements)
            {
                total++;
                try
                {
                    if (stmt is ExpressionStatementSyntax es)
                    {
                        if (es.Expression is AssignmentExpressionSyntax asg)
                        {
                            HandleAssignment(asg, host, root, comps, fieldNames, containerNames, userAsms, explicitMembers);
                            ok++;
                            continue;
                        }
                        if (es.Expression is InvocationExpressionSyntax inv)
                        {
                            if (HandleInvocation(inv, root, comps, userAsms, out string? why)) ok++;
                            else unrep.Add(why ?? stmt.ToString().Trim());
                            continue;
                        }
                    }
                    unrep.Add(stmt.ToString().Trim());
                }
                catch (Exception ex)
                {
                    unrep.Add(stmt.ToString().Trim() + "  [" + ex.GetType().Name + ": " + ex.Message + "]");
                }
            }
            return (total, ok, unrep, explicitMembers);
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
            // toolbox §7.2) would be wrongly treated as the disposal holder, never instantiated, and silently
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
                // unrepresentable (§6.5) rather than create the component and silently drop that
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
            object? val = Eval(asg.Right, pd.PropertyType, userAsms);
            pd.SetValue(target, val);
        }

        /// <summary>True when the expression is the recognized components container (<c>this.components</c>
        /// or a bare <c>components</c>) — gates the sole allowed ctor-arg (provider/tray ctors).</summary>
        private static bool IsContainerArg(ExpressionSyntax arg, HashSet<string> containerNames)
        {
            var c = Flatten(arg);
            return c.Count == 1 && containerNames.Contains(c[0]);
        }

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
            var targetChain = Flatten(ma.Expression);

            if (method is "SuspendLayout" or "ResumeLayout" or "PerformLayout") return true;

            if (method == "Add" && targetChain.Count >= 1 && targetChain[^1] == "Controls")
            {
                Control parent;
                if (targetChain.Count == 1) parent = root;
                else if (comps.TryGetValue(targetChain[0], out var pc) && pc is Control pctl) parent = pctl;
                else { why = "Controls.Add on unknown parent: " + ma.Expression; return false; }

                var addArgs = inv.ArgumentList.Arguments;
                var argChain = Flatten(addArgs[0].Expression);
                if (argChain.Count == 1 && comps.TryGetValue(argChain[0], out var child) && child is Control cctl)
                {
                    parent.Controls.Add(cctl);
                    // TableLayoutPanel uses the 3-arg overload Controls.Add(child, column, row): honor the cell so
                    // the child lands where it was designed. The plain Add above would auto-flow it (rendering the
                    // form wrong — children pile into the first cells). Column/row are int literals (Eval with an
                    // int target); any other shape is ignored and the child stays auto-flowed.
                    if (addArgs.Count == 3 && parent is System.Windows.Forms.TableLayoutPanel tlp)
                    {
                        if (Eval(addArgs[1].Expression, typeof(int), userAsms) is int col) tlp.SetColumn(cctl, col);
                        if (Eval(addArgs[2].Expression, typeof(int), userAsms) is int row) tlp.SetRow(cctl, row);
                    }
                    return true;
                }
                why = "Controls.Add unknown child: " + inv.ArgumentList.Arguments[0];
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
                        else { why = "AddRange: unknown element " + elExpr; return false; }
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
                        object? inner = Eval(u.Operand, targetType, userAsms);
                        if (inner is int i) return -i;
                        if (inner is double d) return -d;
                        if (inner is long l) return -l;
                        return inner;
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

                default:
                    throw new InvalidOperationException("unsupported expression: " + expr.Kind() + " '" + expr + "'");
            }
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
        /// Exact, member-level allowlist for the static-invocation eval path. Only the pure,
        /// side-effect-free Color factory methods the value-converter emits (and that real designer
        /// files contain) may be invoked — never "any static method in an allowed assembly", which
        /// would still expose side-effecting calls like System.Windows.Forms.MessageBox.Show or
        /// System.Drawing.Image.FromFile. Anything not listed becomes unrepresentable (graceful),
        /// which is exactly the pre-change behavior for invocations (no regression).
        /// </summary>
        private static readonly HashSet<string> AllowedStaticInvocations = new(StringComparer.Ordinal)
        {
            "System.Drawing.Color.FromArgb",
            "System.Drawing.Color.FromName",
            "System.Drawing.Color.FromKnownColor",
        };

        private static bool IsFactoryInvocationAllowed(Type t, string methodName) =>
            t.FullName != null && AllowedStaticInvocations.Contains(t.FullName + "." + methodName);

        /// <summary>
        /// Exact, type-name allowlist for the ObjectCreation eval path: the framework types the designer
        /// legitimately CONSTRUCTS as inline property values (Point/Size/Rectangle/Padding + their F-variants,
        /// and Font/FontFamily). This is the ONLY thing that may be constructed on open — nothing else.
        ///
        /// History: this was a namespace check (System.Drawing*/System.Windows.Forms* allowed wholesale) plus a
        /// branch that allowed ANY type from a user/project ALC assembly. Both were unsafe:
        ///   • the namespace check was safe only while System.Drawing.Common stayed OUT of ResolveType's probe;
        ///     once it's in (needed for Font), in-namespace file-reading constructors become reachable —
        ///     new System.Drawing.Bitmap(path)/Icon(path)/Imaging.Metafile(path), and the pre-existing in-probe
        ///     new System.Windows.Forms.Cursor(path);
        ///   • the userAsms branch let a hostile .Designer.cs run an ARBITRARY constructor of any type in the
        ///     project's build output (or any planted/3rd-party sibling DLL auto-loaded from bin/) merely on
        ///     preview-open, e.g. `this.x.Tag = new Evil.Detonator();` (verified RCE-on-open). It was never
        ///     needed for legitimate controls: control instantiation goes through HandleAssignment ->
        ///     host.CreateComponent (parameterless, no initializer), never this gate. The Eval ObjectCreation
        ///     path is only ever reached for inline PROPERTY VALUES, so dropping user-type construction here
        ///     just makes a custom value-type initializer gracefully unrepresentable instead of executing.
        /// A type-name allowlist is, like the old namespace check, robust to assembly re-partitioning (it
        /// matches FullName, not Assembly — the reason the original moved off an assembly list for Padding), but
        /// admits ONLY known side-effect-free value initializers, so no file-reading/BCL/user constructor runs
        /// from a hand-crafted .Designer.cs. Anything not listed becomes gracefully unrepresentable.
        /// </summary>
        private static readonly HashSet<string> AllowedConstructionTypes = new(StringComparer.Ordinal)
        {
            "System.Drawing.Point",
            "System.Drawing.PointF",
            "System.Drawing.Size",
            "System.Drawing.SizeF",
            "System.Drawing.Rectangle",
            "System.Drawing.RectangleF",
            "System.Windows.Forms.Padding",
            "System.Drawing.Font",
            "System.Drawing.FontFamily",
        };

        private static bool IsConstructionAllowed(Type t) =>
            t.FullName != null && AllowedConstructionTypes.Contains(t.FullName);

        /// <summary>
        /// Declaring types whose public static property/field reads are allowed in Eval's MemberAccess path.
        /// Only pure, side-effect-free framework value sources the designer/value-converter actually emit:
        /// named/system colors (Color.Red, SystemColors.Control) and the value structs' static members
        /// (Size.Empty, Point.Empty, …). Enum member reads are handled separately (Enum.Parse, always pure)
        /// and don't go through here. Excludes SystemFonts/SystemIcons/Brushes/Pens (newly reachable via
        /// Drawing.Common), corelib getters (Environment.MachineName), and user-DLL statics, whose getters
        /// could allocate handles or run side effects on open.
        /// </summary>
        private static readonly HashSet<string> AllowedStaticReadTypes = new(StringComparer.Ordinal)
        {
            "System.Drawing.Color",
            "System.Drawing.SystemColors",
            "System.Drawing.Point",
            "System.Drawing.PointF",
            "System.Drawing.Size",
            "System.Drawing.SizeF",
            "System.Drawing.Rectangle",
            "System.Drawing.RectangleF",
            "System.Windows.Forms.Padding",
        };

        private static bool IsStaticReadAllowed(Type t) =>
            t.FullName != null && AllowedStaticReadTypes.Contains(t.FullName);

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
