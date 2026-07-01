using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design.Serialization;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Property-grid + events data for one control of the LIVE compiled instance, via TypeDescriptor — the net48
    /// analogue of the net9 engine's DesignerDescribe, but reading a real runtime component (not a design-surface
    /// one) and emitting the [Serializable] net48 DTOs (they cross the child-AppDomain boundary). The extraction
    /// logic (standard values, flags enums, image thumbnails, invariant stringify) mirrors DesignerDescribe so the
    /// grid behaves identically. SourceExplicit (the "set in source" bold) is left false for now — it needs the
    /// .Designer.cs assignment set, a later refinement.
    /// </summary>
    public static class CompiledDescriber
    {
        public static ComponentDesc Describe(Control target, string id, string name, bool isRoot, string? parent)
        {
            return new ComponentDesc
            {
                Id = id,
                Name = name,
                Type = target.GetType().FullName ?? target.GetType().Name,
                Parent = parent,
                IsRoot = isRoot,
                Properties = DescribeProperties(target),
                Events = DescribeEvents(target),
            };
        }

        private static List<EventDesc> DescribeEvents(IComponent c)
        {
            var list = new List<EventDesc>();
            foreach (EventDescriptor ed in TypeDescriptor.GetEvents(c))
            {
                if (!ed.IsBrowsable) continue;
                list.Add(new EventDesc
                {
                    Name = ed.Name,
                    Type = ed.EventType.FullName ?? ed.EventType.Name,
                    Category = string.IsNullOrEmpty(ed.Category) ? "Misc" : ed.Category,
                    Handler = null, // wired-handler parse from .Designer.cs is a later refinement
                });
            }
            list.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return list;
        }

        private static List<PropertyDesc> DescribeProperties(IComponent c)
        {
            var list = new List<PropertyDesc>();
            bool parentIsTlp = c is Control pctl && pctl.Parent is TableLayoutPanel;
            foreach (PropertyDescriptor pd in TypeDescriptor.GetProperties(c))
            {
                if (!pd.IsBrowsable) continue;
                bool isTableCell = parentIsTlp && (pd.Name == "Column" || pd.Name == "Row");
                var vis = (DesignerSerializationVisibilityAttribute?)pd.Attributes[typeof(DesignerSerializationVisibilityAttribute)];
                if (vis != null && vis.Visibility == DesignerSerializationVisibility.Hidden && !isTableCell) continue;

                object? raw = null;
                try { raw = pd.GetValue(c); } catch { raw = null; }

                string? value = null;
                try { value = StringifyInvariant(pd, raw); } catch { value = null; }

                bool? isDefault = null;
                try { isDefault = !pd.ShouldSerializeValue(c); } catch { isDefault = null; }

                // A Font carrying a non-default charset would lose it through the invariant string form — show read-only.
                bool readOnly = pd.IsReadOnly;
                if (raw is System.Drawing.Font font && (font.GdiCharSet != 1 || font.GdiVerticalFont))
                {
                    readOnly = true;
                }

                var (standardValues, stdExclusive) = StandardValuesOf(pd);
                bool isImage = IsImageProperty(pd.PropertyType);
                string? imagePreview = isImage ? TryThumbnail(raw) : null;

                list.Add(new PropertyDesc
                {
                    Name = pd.Name,
                    Type = pd.PropertyType.FullName ?? pd.PropertyType.Name,
                    Value = value,
                    IsDefault = isDefault,
                    SourceExplicit = false,
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
                    if (vals.Count >= 256) break;
                }
                if (vals.Count == 0) return (null, false);
                bool excl = false;
                try { excl = conv.GetStandardValuesExclusive(); } catch { excl = false; }
                return (vals, excl);
            }
            catch { return (null, false); }
        }

        private static List<string>? FlagsMembersOf(Type t)
        {
            try
            {
                if (!t.IsEnum || !t.IsDefined(typeof(FlagsAttribute), false)) return null;
                var members = new List<string>();
                foreach (var name in Enum.GetNames(t))
                {
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
                    if (u == 0) continue;
                    if ((u & (u - 1)) != 0) continue;
                    members.Add(name);
                }
                return members.Count > 0 ? members : null;
            }
            catch { return null; }
        }

        private static string? FlagsZeroOf(Type t)
        {
            try
            {
                if (!t.IsEnum || !t.IsDefined(typeof(FlagsAttribute), false)) return null;
                return Enum.GetName(t, Enum.ToObject(t, 0L));
            }
            catch { return null; }
        }

        private static bool IsImageProperty(Type t) =>
            typeof(System.Drawing.Image).IsAssignableFrom(t) || t == typeof(System.Drawing.Icon);

        private const int ThumbMax = 64;
        private const long MaxSrcPixels = 4096L * 4096L;

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
                    if (w <= 0 || h <= 0 || w > 20000 || h > 20000 || (long)w * h > MaxSrcPixels) return null;
                    double scale = Math.Min(1.0, Math.Min((double)ThumbMax / w, (double)ThumbMax / h));
                    int tw = Math.Max(1, (int)Math.Round(w * scale));
                    int th = Math.Max(1, (int)Math.Round(h * scale));
                    using (var thumb = new System.Drawing.Bitmap(tw, th, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                    {
                        using (var g = System.Drawing.Graphics.FromImage(thumb))
                        {
                            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                            g.DrawImage(src, new System.Drawing.Rectangle(0, 0, tw, th));
                        }
                        using (var ms = new System.IO.MemoryStream())
                        {
                            thumb.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                            return Convert.ToBase64String(ms.ToArray());
                        }
                    }
                }
                finally { icoBmp?.Dispose(); }
            }
            catch { return null; }
        }

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
