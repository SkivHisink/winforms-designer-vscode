using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

namespace WinFormsDesigner.Engine
{
    public enum LocalizedResourceEditKind
    {
        UpsertScalar,
        RemoveOverride,
        UpsertImage,
        UpsertIcon,
    }

    public sealed class LocalizedResourceEdit
    {
        public LocalizedResourceEditKind Kind { get; init; } = LocalizedResourceEditKind.UpsertScalar;
        public string ComponentId { get; init; } = "";
        public string PropertyName { get; init; } = "";
        public string ValueTypeName { get; init; } = "System.String";
        public string? ScalarValue { get; init; }
        public byte[]? BinaryValue { get; init; }
    }

    public sealed class LocalizedResourceEditResult
    {
        public bool Ok { get; init; }
        public string? ResxText { get; init; }
        public IReadOnlyList<string> Keys { get; init; } = Array.Empty<string>();
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Pure in-memory editor for localized .resx override files. It preserves non-target XML nodes as opaque XML,
    /// refuses malformed existing files, and validates all scalar values with invariant-culture converters before
    /// emitting a data node.
    /// </summary>
    public static class DesignerLocalizedResxEditor
    {
        private const int MaxBatch = 500;
        private const int MaxScalarChars = 1024 * 1024;
        private const int MaxImageBytes = 16 * 1024 * 1024;
        private const int MaxResxChars = 64 * 1024 * 1024;
        private const int MaxDimension = 20000;
        private const long MaxPixels = 4096L * 4096L;

        private static readonly Dictionary<string, (Type Type, string? TypeAttr)> ScalarTypes =
            new(StringComparer.Ordinal)
            {
                ["System.String"] = (typeof(string), null),
                ["System.Boolean"] = (typeof(bool), "System.Boolean, mscorlib"),
                ["System.Byte"] = (typeof(byte), "System.Byte, mscorlib"),
                ["System.SByte"] = (typeof(sbyte), "System.SByte, mscorlib"),
                ["System.Int16"] = (typeof(short), "System.Int16, mscorlib"),
                ["System.UInt16"] = (typeof(ushort), "System.UInt16, mscorlib"),
                ["System.Int32"] = (typeof(int), "System.Int32, mscorlib"),
                ["System.UInt32"] = (typeof(uint), "System.UInt32, mscorlib"),
                ["System.Int64"] = (typeof(long), "System.Int64, mscorlib"),
                ["System.UInt64"] = (typeof(ulong), "System.UInt64, mscorlib"),
                ["System.Single"] = (typeof(float), "System.Single, mscorlib"),
                ["System.Double"] = (typeof(double), "System.Double, mscorlib"),
                ["System.Decimal"] = (typeof(decimal), "System.Decimal, mscorlib"),
                ["System.Drawing.Point"] = (typeof(Point), "System.Drawing.Point, System.Drawing"),
                ["System.Drawing.Size"] = (typeof(Size), "System.Drawing.Size, System.Drawing"),
                ["System.Drawing.SizeF"] = (typeof(SizeF), "System.Drawing.SizeF, System.Drawing"),
                ["System.Drawing.Rectangle"] = (typeof(Rectangle), "System.Drawing.Rectangle, System.Drawing"),
                ["System.Drawing.Color"] = (typeof(Color), "System.Drawing.Color, System.Drawing"),
                ["System.Drawing.Font"] = (typeof(Font), "System.Drawing.Font, System.Drawing"),
                ["System.Windows.Forms.Padding"] = (typeof(System.Windows.Forms.Padding), "System.Windows.Forms.Padding, System.Windows.Forms"),
                ["System.Windows.Forms.RightToLeft"] = (typeof(System.Windows.Forms.RightToLeft), "System.Windows.Forms.RightToLeft, System.Windows.Forms"),
                ["System.Windows.Forms.AnchorStyles"] = (typeof(System.Windows.Forms.AnchorStyles), "System.Windows.Forms.AnchorStyles, System.Windows.Forms"),
                ["System.Windows.Forms.DockStyle"] = (typeof(System.Windows.Forms.DockStyle), "System.Windows.Forms.DockStyle, System.Windows.Forms"),
                ["System.Windows.Forms.FlatStyle"] = (typeof(System.Windows.Forms.FlatStyle), "System.Windows.Forms.FlatStyle, System.Windows.Forms"),
                ["System.Drawing.ContentAlignment"] = (typeof(ContentAlignment), "System.Drawing.ContentAlignment, System.Drawing"),
            };

        /// <summary>Whether a property type can round-trip through the .resx writer — the gate the localizable
        /// conversion uses to decide what may move out of generated code and what has to stay in it.</summary>
        public static bool SupportsScalarType(string typeFullName) => ScalarTypes.ContainsKey(typeFullName);

        public static LocalizedResourceEditResult ApplyEdits(string? resxText, IReadOnlyList<LocalizedResourceEdit> edits)
        {
            if (edits == null || edits.Count == 0) return Fail("no edits");
            if (edits.Count > MaxBatch) return Fail("too many edits in one batch");
            if (resxText != null && resxText.Length > MaxResxChars) return Fail("existing .resx is too large to modify safely");

            string? current = resxText;
            var keys = new List<string>();
            foreach (var edit in edits)
            {
                if (!TryKey(edit.ComponentId, edit.PropertyName, out var key, out var reason)) return Fail(reason);
                keys.Add(key);
                string? next = edit.Kind switch
                {
                    LocalizedResourceEditKind.UpsertScalar => UpsertScalar(current, key, edit.ValueTypeName, edit.ScalarValue, out reason),
                    LocalizedResourceEditKind.RemoveOverride => Remove(current, key, out reason),
                    LocalizedResourceEditKind.UpsertImage => UpsertImage(current, key, false, edit.BinaryValue, out reason),
                    LocalizedResourceEditKind.UpsertIcon => UpsertImage(current, key, true, edit.BinaryValue, out reason),
                    _ => FailText("unsupported localized edit kind", out reason),
                };
                if (next == null) return Fail(reason);
                current = next;
            }

            return new LocalizedResourceEditResult { Ok = true, ResxText = current, Keys = keys };
        }

        public static LocalizedResourceEditResult ApplyScalarEdits(string? resxText, IReadOnlyList<LocalizedResourceEdit> edits)
        {
            if (edits.Any(e => e.Kind != LocalizedResourceEditKind.UpsertScalar && e.Kind != LocalizedResourceEditKind.RemoveOverride))
                return Fail("batch contains non-scalar localized edits");
            return ApplyEdits(resxText, edits);
        }

        private static string? UpsertScalar(string? resxText, string key, string valueTypeName, string? rawValue, out string reason)
        {
            reason = "";
            if (!ScalarTypes.TryGetValue(valueTypeName, out var info))
            {
                reason = "unsupported localized scalar type: " + valueTypeName;
                return null;
            }
            rawValue ??= "";
            if (rawValue.Length > MaxScalarChars)
            {
                reason = "localized scalar value is too large";
                return null;
            }
            if (!TryNormalizeScalar(info.Type, rawValue, out var normalized, out reason)) return null;
            return Mutate(resxText, key, () =>
            {
                var data = new XElement("data", new XAttribute("name", key));
                if (info.TypeAttr != null) data.Add(new XAttribute("type", info.TypeAttr));
                else data.Add(new XAttribute(XNamespace.Xml + "space", "preserve"));
                data.Add(new XElement("value", normalized));
                return data;
            }, remove: false, out reason);
        }

        private static string? Remove(string? resxText, string key, out string reason) =>
            Mutate(resxText, key, makeNode: null, remove: true, out reason);

        private static string? UpsertImage(string? resxText, string key, bool icon, byte[]? bytes, out string reason)
        {
            reason = "";
            if (bytes == null || bytes.Length == 0)
            {
                reason = "no image data";
                return null;
            }
            if (bytes.Length > MaxImageBytes)
            {
                reason = "image is too large";
                return null;
            }
            string? err = ValidateImageBytes(bytes, icon);
            if (err != null)
            {
                reason = err;
                return null;
            }
            string typeAttr = icon ? "System.Drawing.Icon, System.Drawing.Common" : "System.Drawing.Bitmap, System.Drawing.Common";
            string? text = ResxImageWriter.Upsert(resxText, key, typeAttr, Convert.ToBase64String(bytes));
            if (text == null) reason = "the existing .resx is malformed and was not modified";
            return text;
        }

        private static bool TryKey(string componentId, string propertyName, out string key, out string reason)
        {
            key = "";
            reason = "";
            bool isRoot = componentId is "this" or "";
            if (!isRoot && !DesignerControlEditor.IsValidIdentifier(componentId))
            {
                reason = "invalid component id: " + componentId;
                return false;
            }
            if (!DesignerControlEditor.IsValidIdentifier(propertyName))
            {
                reason = "invalid property name: " + propertyName;
                return false;
            }
            key = isRoot ? "$this." + propertyName : componentId + "." + propertyName;
            return true;
        }

        private static bool TryNormalizeScalar(Type type, string raw, out string normalized, out string reason)
        {
            normalized = raw;
            reason = "";
            if (type == typeof(string)) return true;
            try
            {
                object? value;
                if (type.IsEnum)
                {
                    value = Enum.Parse(type, raw, ignoreCase: false);
                    normalized = value.ToString() ?? raw;
                    return true;
                }
                var converter = TypeDescriptor.GetConverter(type);
                if (!converter.CanConvertFrom(typeof(string)) || !converter.CanConvertTo(typeof(string)))
                {
                    reason = "localized scalar type has no invariant converter: " + type.FullName;
                    return false;
                }
                value = converter.ConvertFromInvariantString(raw);
                normalized = converter.ConvertToInvariantString(value) ?? raw;
                return true;
            }
            catch (Exception ex)
            {
                reason = "invalid invariant " + type.FullName + " value: " + ex.Message;
                return false;
            }
        }

        private static string? Mutate(string? resxText, string key, Func<XElement>? makeNode, bool remove, out string reason)
        {
            reason = "";
            XDocument doc;
            if (string.IsNullOrWhiteSpace(resxText))
            {
                doc = Skeleton();
            }
            else
            {
                try
                {
                    var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
                    using var sr = new StringReader(resxText);
                    using var xr = XmlReader.Create(sr, settings);
                    doc = XDocument.Load(xr);
                }
                catch
                {
                    reason = "the existing .resx is malformed and was not modified";
                    return null;
                }
                if (doc.Root == null || doc.Root.Name.LocalName != "root")
                {
                    reason = "the existing .resx has no root element";
                    return null;
                }
            }

            var root = doc.Root!;
            root.Elements("data").Where(d => (string?)d.Attribute("name") == key).ToList().ForEach(d => d.Remove());
            if (!remove && makeNode != null) root.Add(makeNode());
            return Serialize(doc);
        }

        private static string? FailText(string message, out string reason)
        {
            reason = message;
            return null;
        }

        private static LocalizedResourceEditResult Fail(string reason) =>
            new() { Ok = false, Reason = reason };

        private static string Serialize(XDocument doc)
        {
            StripStructuralWhitespace(doc.Root!);
            var settings = new XmlWriterSettings
            {
                OmitXmlDeclaration = true,
                Indent = true,
                IndentChars = "  ",
                NewLineChars = "\r\n",
                NewLineHandling = NewLineHandling.None,
            };
            var sb = new System.Text.StringBuilder();
            using (var w = XmlWriter.Create(sb, settings)) doc.Root!.Save(w);
            return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n" + sb;
        }

        private static void StripStructuralWhitespace(XElement el)
        {
            if (!el.Elements().Any()) return;
            foreach (var t in el.Nodes().OfType<XText>().Where(t => string.IsNullOrWhiteSpace(t.Value)).ToList())
                t.Remove();
            foreach (var child in el.Elements()) StripStructuralWhitespace(child);
        }

        private static XDocument Skeleton()
        {
            XElement Header(string name, string value) =>
                new("resheader", new XAttribute("name", name), new XElement("value", value));
            return new XDocument(new XElement("root",
                Header("resmimetype", "text/microsoft-resx"),
                Header("version", "2.0"),
                Header("reader", "System.Resources.ResXResourceReader, System.Windows.Forms"),
                Header("writer", "System.Resources.ResXResourceWriter, System.Windows.Forms")));
        }

        private static string? ValidateImageBytes(byte[] bytes, bool isIcon)
        {
            try
            {
                using var ms = new MemoryStream(bytes, writable: false);
                if (isIcon)
                {
                    using var ico = new Icon(ms);
                    if (ico.Width <= 0 || ico.Height <= 0 || ico.Width > MaxDimension || ico.Height > MaxDimension
                        || (long)ico.Width * ico.Height > MaxPixels)
                        return "icon dimensions are out of range";
                    return null;
                }
                int w, h;
                using (var probe = Image.FromStream(ms, useEmbeddedColorManagement: false, validateImageData: false))
                {
                    w = probe.Width;
                    h = probe.Height;
                }
                if (w <= 0 || h <= 0 || w > MaxDimension || h > MaxDimension || (long)w * h > MaxPixels)
                    return "image dimensions are out of range";
                ms.Position = 0;
                using (var img = Image.FromStream(ms, useEmbeddedColorManagement: false, validateImageData: true))
                {
                    if (img.Width <= 0 || img.Height <= 0) return "image dimensions are out of range";
                }
                return null;
            }
            catch (Exception ex)
            {
                return isIcon ? "not a valid icon file (" + ex.GetType().Name + ")"
                              : "not a valid image file (" + ex.GetType().Name + ")";
            }
        }
    }
}
