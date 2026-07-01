using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Linq;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine
{
    public sealed class PropertyInfo
    {
        public string Name { get; init; } = "";
        public string Type { get; init; } = "";
        /// <summary>Current value as an invariant string, or null if null / not invariantly convertible.</summary>
        public string? Value { get; init; }
        /// <summary>
        /// TypeDescriptor.ShouldSerializeValue == false (raw "has a non-default value"); null when it could
        /// not be determined. NOTE: over-reports standalone-host noise (Visible/Enabled/collections) — for a
        /// grid's "set in source" bold use <see cref="SourceExplicit"/> instead.
        /// </summary>
        public bool? IsDefault { get; init; }
        /// <summary>True when this property was explicitly assigned in the source .Designer.cs (grid bold signal).</summary>
        public bool SourceExplicit { get; init; }
        public bool ReadOnly { get; init; }
        /// <summary>Enum type — lets the editor build a fully-qualified `Type.Member` C# expression.</summary>
        public bool IsEnum { get; init; }
        public string Category { get; init; } = "Misc";
        /// <summary>The property's TypeConverter standard values as invariant strings (§7.1 dropdowns), or null
        /// when the converter exposes none. Populated for enums (non-flags), Boolean, named Colors, etc. Flags
        /// enums are left null (a single-select can't represent "Top, Left") → the editor keeps a text input.</summary>
        public List<string>? StandardValues { get; init; }
        /// <summary>True when the standard-values set is closed (TypeConverter.GetStandardValuesExclusive) → the
        /// editor renders a &lt;select&gt;; false → an editable combobox (datalist) that also accepts free text.</summary>
        public bool StandardValuesExclusive { get; init; }
        /// <summary>For a [Flags] enum: the individual single-bit member names (e.g. Top/Bottom/Left/Right for
        /// AnchorStyles), so the grid can render a checkbox dropdown that composes "Top, Left". Null for
        /// non-flags enums / non-enums. Anchor keeps its dedicated visual editor; other flags enums use these.
        /// StandardValues is intentionally null for flags (a single-select can't express combined flags).</summary>
        public List<string>? FlagsMembers { get; init; }
        /// <summary>For a [Flags] enum: the name of its zero-valued member (e.g. "None"), so the checkbox
        /// dropdown can commit a valid value when the user unchecks everything. Null when the enum has no
        /// zero member (rare — most WinForms flags enums define None=0).</summary>
        public string? FlagsZero { get; init; }
        /// <summary>True for a TableLayoutPanel child's Column/Row extender (surfaced despite its Hidden
        /// serialization-visibility). The grid edits these via SetTableCell — which rewrites the 3-arg
        /// Controls.Add cell args — NOT a normal property assignment. Display + edit-routing signal.</summary>
        public bool TableCell { get; init; }
        /// <summary>True when the property's value type is an image/icon (System.Drawing.Image/Bitmap/Icon). Its
        /// value is not a literal (<see cref="Value"/> stays null), so the grid renders a preview swatch +
        /// Import…/(none) editor (resx-backed) instead of a text field. Edit-routing + display signal.</summary>
        public bool IsImage { get; init; }
        /// <summary>A small base64 PNG thumbnail of the current image value (max 64×64, aspect-preserved), or null
        /// when the property is unset / not an image / couldn't be rendered. Display-only; never disposes the live value.</summary>
        public string? ImagePreview { get; init; }
    }

    /// <summary>One event of a component, for the Events tab. <see cref="Handler"/> is the wired handler
    /// method name parsed from the source (<c>this.btn.Click += new EventHandler(this.btn_Click)</c> →
    /// "btn_Click"), or null when the event has no handler.</summary>
    public sealed class EventInfo
    {
        public string Name { get; init; } = "";
        /// <summary>The delegate type (e.g. System.EventHandler) — for a future "generate handler" stub.</summary>
        public string Type { get; init; } = "";
        public string Category { get; init; } = "Misc";
        /// <summary>Wired handler method name from the source, or null if unhandled.</summary>
        public string? Handler { get; init; }
    }

    public sealed class ComponentInfo
    {
        /// <summary>Edit id to pass to SetProperty: "this" for the root, Site.Name for other components.</summary>
        public string Id { get; init; } = "";
        /// <summary>Display name: the class name for the root, Site.Name for other components.</summary>
        public string Name { get; init; } = "";
        public string Type { get; init; } = "";
        /// <summary>Parent component display name, or null for the root.</summary>
        public string? Parent { get; init; }
        public bool IsRoot { get; init; }
        public List<PropertyInfo> Properties { get; init; } = new();
        /// <summary>The component's events (name + category + wired handler) — the Events-tab data.</summary>
        public List<EventInfo> Events { get; init; } = new();
    }

    public sealed class DescribeResult
    {
        public string RootType { get; init; } = "";
        public List<ComponentInfo> Components { get; init; } = new();
        public int TotalStatements { get; init; }
        public int Representable { get; init; }
        public List<string> Unrepresentable { get; init; } = new();
        public bool RoundTripSafe => Unrepresentable.Count == 0;
    }

    /// <summary>
    /// Enumerates a loaded designer graph into a serializable description (controls + their browsable
    /// properties with current values) — the read-side data layer behind a property grid. Pairs with
    /// <see cref="DesignerPropertyEditor"/> for the write side: the grid reads here (selection →
    /// properties) and writes via SetProperty using <see cref="ComponentInfo.Id"/>.
    ///
    /// Two entry points: <see cref="Describe"/> (whole form) for CLI/overview, and
    /// <see cref="DescribeComponent"/> (one component) — the bounded path a grid should use per
    /// selection so a hostile/slow third-party property getter can't be triggered across every control
    /// at once. (A true hang-guard for a stuck getter still needs a process-level watchdog — boundary.)
    /// </summary>
    public static class DesignerDescribe
    {
        public static DescribeResult Describe(IDesignerHost host, string rootName,
            HashSet<(IComponent, string)> explicitMembers,
            int total, int representable, List<string> unrepresentable,
            Dictionary<string, Dictionary<string, string>>? eventWirings = null)
        {
            var root = host.RootComponent;
            var components = host.Container.Components
                .Cast<IComponent>()
                .Select(c => BuildComponentInfo(c, root, rootName, explicitMembers, eventWirings))
                .OrderByDescending(c => c.IsRoot)
                .ThenBy(c => c.Name, StringComparer.Ordinal)
                .ToList();

            return new DescribeResult
            {
                RootType = root.GetType().FullName ?? root.GetType().Name,
                Components = components,
                TotalStatements = total,
                Representable = representable,
                Unrepresentable = unrepresentable,
            };
        }

        /// <summary>Describe a single component by edit id ("this" = root). null if not found.</summary>
        public static ComponentInfo? DescribeComponent(IDesignerHost host, string rootName,
            HashSet<(IComponent, string)> explicitMembers, string componentId,
            Dictionary<string, Dictionary<string, string>>? eventWirings = null)
        {
            var root = host.RootComponent;
            IComponent? target = (componentId is "this" or "")
                ? root
                : host.Container.Components.Cast<IComponent>().FirstOrDefault(c => c.Site?.Name == componentId);
            return target == null ? null : BuildComponentInfo(target, root, rootName, explicitMembers, eventWirings);
        }

        private static ComponentInfo BuildComponentInfo(IComponent c, IComponent root, string rootName,
            HashSet<(IComponent, string)> explicitMembers,
            Dictionary<string, Dictionary<string, string>>? eventWirings)
        {
            bool isRoot = ReferenceEquals(c, root);
            string idKey = isRoot ? "this" : (c.Site?.Name ?? "");
            Dictionary<string, string>? wired = null;
            eventWirings?.TryGetValue(idKey, out wired);
            return new ComponentInfo
            {
                Id = idKey,
                Name = isRoot ? rootName : (c.Site?.Name ?? ""),
                Type = c.GetType().FullName ?? c.GetType().Name,
                Parent = ParentName(c, root, rootName),
                IsRoot = isRoot,
                Properties = DescribeProperties(c, explicitMembers),
                Events = DescribeEvents(c, wired),
            };
        }

        /// <summary>Enumerate a component's browsable events (name + delegate type + category) with the
        /// handler method wired in the source (if any) — the Events-tab data.</summary>
        private static List<EventInfo> DescribeEvents(IComponent c, Dictionary<string, string>? wired)
        {
            var list = new List<EventInfo>();
            foreach (EventDescriptor ed in TypeDescriptor.GetEvents(c))
            {
                if (!ed.IsBrowsable) continue;
                string? handler = null;
                wired?.TryGetValue(ed.Name, out handler);
                list.Add(new EventInfo
                {
                    Name = ed.Name,
                    Type = ed.EventType.FullName ?? ed.EventType.Name,
                    Category = string.IsNullOrEmpty(ed.Category) ? "Misc" : ed.Category,
                    Handler = handler,
                });
            }
            list.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return list;
        }

        private static string? ParentName(IComponent c, IComponent root, string rootName)
        {
            if (ReferenceEquals(c, root)) return null;
            if (c is Control ctl && ctl.Parent is Control p)
            {
                return ReferenceEquals(p, root) ? rootName : (p.Site?.Name ?? "");
            }
            return null;
        }

        private static List<PropertyInfo> DescribeProperties(IComponent c, HashSet<(IComponent, string)> explicitMembers)
        {
            var list = new List<PropertyInfo>();
            // a child sited directly in a TableLayoutPanel exposes the panel's Column/Row extender properties; they
            // carry [DesignerSerializationVisibility(Hidden)] (the 3-arg Controls.Add is their serialization), so the
            // Hidden filter below would drop them — surface them anyway and route their edits through SetTableCell.
            bool parentIsTlp = c is Control pctl && pctl.Parent is System.Windows.Forms.TableLayoutPanel;
            foreach (PropertyDescriptor pd in TypeDescriptor.GetProperties(c))
            {
                if (!pd.IsBrowsable) continue;
                bool isTableCell = parentIsTlp && (pd.Name == "Column" || pd.Name == "Row");
                var vis = (DesignerSerializationVisibilityAttribute?)pd.Attributes[typeof(DesignerSerializationVisibilityAttribute)];
                if (vis != null && vis.Visibility == DesignerSerializationVisibility.Hidden && !isTableCell) continue;

                // read value and default-state in SEPARATE guarded blocks: a throwing ShouldSerializeValue
                // must not discard a value that read fine, and vice versa.
                object? raw = null;
                try { raw = pd.GetValue(c); }
                catch { raw = null; }

                string? value = null;
                try { value = StringifyInvariant(pd, raw); }
                catch { value = null; }

                bool? isDefault = null;
                try { isDefault = !pd.ShouldSerializeValue(c); }
                catch { isDefault = null; }

                // The grid edits a Font through its invariant string, but FontConverter's string form omits
                // GdiCharSet/GdiVerticalFont — so editing a Font that carries a non-default charset (e.g. 204 =
                // RUSSIAN_CHARSET, common in Cyrillic/CJK forms) would silently drop the charset on save. Show
                // such a Font read-only so the value can't be lost; plain fonts (charset 1) stay editable.
                bool readOnly = pd.IsReadOnly;
                if (raw is System.Drawing.Font font && (font.GdiCharSet != 1 || font.GdiVerticalFont))
                {
                    readOnly = true;
                }

                var (standardValues, stdExclusive) = StandardValuesOf(pd);

                // Image/Icon properties (BackgroundImage, PictureBox.Image, Form.Icon…): the value isn't a
                // literal, so surface a thumbnail preview + the resx-backed Import…/(none) editor instead of text.
                bool isImage = IsImageProperty(pd.PropertyType);
                string? imagePreview = isImage ? TryThumbnail(raw) : null;

                list.Add(new PropertyInfo
                {
                    Name = pd.Name,
                    Type = pd.PropertyType.FullName ?? pd.PropertyType.Name,
                    Value = value,
                    IsDefault = isDefault,
                    SourceExplicit = explicitMembers.Contains((c, pd.Name)),
                    ReadOnly = readOnly,
                    IsEnum = pd.PropertyType.IsEnum,
                    Category = string.IsNullOrEmpty(pd.Category) ? "Misc" : pd.Category,
                    StandardValues = standardValues,
                    StandardValuesExclusive = stdExclusive,
                    FlagsMembers = FlagsMembersOf(pd.PropertyType),
                    FlagsZero = FlagsZeroOf(pd.PropertyType),
                    TableCell = isTableCell,
                    IsImage = isImage,
                    ImagePreview = imagePreview,
                });
            }
            list.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return list;
        }

        /// <summary>§7.1: the property's TypeConverter standard values as invariant strings + whether the set is
        /// exclusive (closed). Returns (null, false) when none are offered, the type is a flags enum (a
        /// single-select can't express combined flags), or any value fails to stringify. Bounded and fully
        /// guarded — a hostile converter degrades to no dropdown, never throws.</summary>
        private static (List<string>?, bool) StandardValuesOf(PropertyDescriptor pd)
        {
            try
            {
                if (pd.PropertyType.IsEnum && pd.PropertyType.IsDefined(typeof(FlagsAttribute), false)) return (null, false);
                var conv = pd.Converter;
                if (conv == null || !conv.GetStandardValuesSupported()) return (null, false);
                var coll = conv.GetStandardValues();
                if (coll == null) return (null, false);
                var vals = new List<string>();
                foreach (var sv in coll)
                {
                    if (sv == null) continue;
                    string? s = null;
                    try { if (conv.CanConvertTo(typeof(string))) s = conv.ConvertToInvariantString(sv); } catch { s = null; }
                    if (!string.IsNullOrEmpty(s) && !vals.Contains(s!)) vals.Add(s!);
                    if (vals.Count >= 256) break; // bound — keep the payload sane for huge converters
                }
                if (vals.Count == 0) return (null, false);
                // guard the exclusivity query separately — a converter that enumerates fine but throws here
                // should still yield the (non-exclusive) dropdown rather than discard the whole list.
                bool excl = false;
                try { excl = conv.GetStandardValuesExclusive(); } catch { excl = false; }
                return (vals, excl);
            }
            catch { return (null, false); }
        }

        /// <summary>The individual single-bit member names of a [Flags] enum (value != 0 and a power of two),
        /// in declaration order — the atomic flags a checkbox dropdown toggles. Null for non-flags / non-enums,
        /// or when the enum exposes no single-bit members. Fully guarded (never throws).</summary>
        private static List<string>? FlagsMembersOf(Type t)
        {
            try
            {
                if (!t.IsEnum || !t.IsDefined(typeof(FlagsAttribute), false)) return null;
                var members = new List<string>();
                foreach (var name in Enum.GetNames(t))
                {
                    // Read the member as its UNSIGNED bit pattern masked to the enum's underlying width, so a
                    // high-bit single flag isn't misclassified as composite: a signed Int64 widening would
                    // sign-extend int 0x80000000 to 0xFFFFFFFF80000000 (fails the power-of-two test), and a
                    // UInt64 member > long.MaxValue would overflow Convert.ToInt64. The per-underlying-type
                    // cast reinterprets the exact width instead.
                    ulong u;
                    try
                    {
                        object uv = Convert.ChangeType(Enum.Parse(t, name), Enum.GetUnderlyingType(t));
                        u = uv switch
                        {
                            byte b => b,
                            sbyte sb => (byte)sb,
                            short s => (ushort)s,
                            ushort us => us,
                            int i => (uint)i,
                            uint ui => ui,
                            long l => (ulong)l,
                            ulong ul => ul,
                            _ => 0UL,
                        };
                    }
                    catch { continue; }
                    if (u == 0) continue;              // skip the zero member (None)
                    if ((u & (u - 1)) != 0) continue;  // skip composite (multi-bit) members
                    members.Add(name);
                }
                return members.Count > 0 ? members : null;
            }
            catch { return null; }
        }

        /// <summary>The name of a [Flags] enum's zero-valued member (e.g. "None"), or null. Lets the checkbox
        /// dropdown commit a valid value when everything is unchecked. Guarded (never throws).</summary>
        private static string? FlagsZeroOf(Type t)
        {
            try
            {
                if (!t.IsEnum || !t.IsDefined(typeof(FlagsAttribute), false)) return null;
                return Enum.GetName(t, Enum.ToObject(t, 0L));
            }
            catch { return null; }
        }

        /// <summary>True when a property's value type is an image/icon (System.Drawing.Image and its subclasses —
        /// Bitmap/Metafile — or System.Drawing.Icon). Drives the grid's preview + Import…/(none) editor.</summary>
        private static bool IsImageProperty(Type t) =>
            typeof(System.Drawing.Image).IsAssignableFrom(t) || t == typeof(System.Drawing.Icon);

        private const int ThumbMax = 64;             // preview swatch cap (px); larger sources are scaled down, aspect-preserved
        private const long MaxSrcPixels = 4096L * 4096L; // total-pixel bound on the SOURCE — reject a pixel bomb before DrawImage allocates

        /// <summary>Render an image/icon property's LIVE value to a small base64 PNG thumbnail (≤ <see cref="ThumbMax"/>
        /// px, aspect-preserved), or null when there's no value / it's not an image / it can't be rendered. Draws the
        /// source directly into the thumbnail (no full-size clone) and NEVER disposes the live value — only an
        /// icon-derived temporary bitmap is disposed. Fully guarded: any failure degrades to null (no preview).</summary>
        private static string? TryThumbnail(object? raw)
        {
            try
            {
                System.Drawing.Image? src;
                System.Drawing.Bitmap? icoBmp = null;
                if (raw is System.Drawing.Icon ico) { icoBmp = ico.ToBitmap(); src = icoBmp; }
                else if (raw is System.Drawing.Image img) src = img;
                else return null;
                try
                {
                    int w = src.Width, h = src.Height;
                    // bound the SOURCE dimensions AND total pixels before allocating — a pixel-bomb image already
                    // materialized by the resx reader must not also balloon a full-frame thumbnail draw. The
                    // long-cast product guards against a huge-on-both-axes image slipping past per-axis caps.
                    if (w <= 0 || h <= 0 || w > 20000 || h > 20000 || (long)w * h > MaxSrcPixels) return null;
                    double scale = Math.Min(1.0, Math.Min((double)ThumbMax / w, (double)ThumbMax / h));
                    int tw = Math.Max(1, (int)Math.Round(w * scale));
                    int th = Math.Max(1, (int)Math.Round(h * scale));
                    using var thumb = new System.Drawing.Bitmap(tw, th, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                    using (var g = System.Drawing.Graphics.FromImage(thumb))
                    {
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                        g.DrawImage(src, new System.Drawing.Rectangle(0, 0, tw, th));
                    }
                    using var ms = new System.IO.MemoryStream();
                    thumb.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                    return Convert.ToBase64String(ms.ToArray());
                }
                finally { icoBmp?.Dispose(); } // dispose only the icon-derived temp; never the live `img`
            }
            catch { return null; }
        }

        /// <summary>Invariant string via the property's TypeConverter, or null (no arbitrary ToString fallback).</summary>
        private static string? StringifyInvariant(PropertyDescriptor pd, object? v)
        {
            if (v == null) return null;
            if (pd.Converter is { } conv && conv.CanConvertTo(typeof(string)))
            {
                return conv.ConvertToInvariantString(v);
            }
            return null;
        }
    }
}
