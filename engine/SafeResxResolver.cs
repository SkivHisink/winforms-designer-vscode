using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Xml;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The SAFE .resx resolver for the interpreted path. The live
    // sibling .resx is repository-controlled input, and BinaryFormatter cannot be made safe for untrusted input on
    // ANY .NET Framework version. So the interpreted resolver NEVER deserializes a binary/SOAP payload or a
    // ResXFileRef — it returns null for those, which makes the owning statement fail closed → the form uses the
    // disclosed compiled fallback with reason `unsafeBinaryResource`. Only plain inline string values (and their
    // GetString use) are served. This mirrors the modern engine's DesignerResx, which refuses the same nodes BEFORE
    // GetValue — the net48 interpreter must not be weaker merely because the Framework runtime still ships the
    // dangerous serializer. For ApplyResources, a small allowlist of ordinary VS scalar property types is converted
    // through invariant TypeDescriptor paths. Images/icons additionally accept only the standard raw byte-array resx
    // MIME, with strict decoded-size and dimension limits; every serialized-object/SOAP/file-backed node is refused.
    //
    // A full-trust child AppDomain is NOT a sandbox: safety here is REFUSAL, not containment. Parsing is pure XML
    // (System.Xml, both TFMs); no resource assembly is loaded, no type is activated.
    // ============================================================================================================
    public sealed class SafeResxResolver
    {
        private const string ByteArrayBase64Mime = "application/x-microsoft.net.object.bytearray.base64";
        private const int MaxImageBytes = 16 * 1024 * 1024;
        private const int MaxImageDimension = 20000;
        private const long MaxImagePixels = 4096L * 4096L;
        private const int MaxImageBase64Chars = ((MaxImageBytes + 2) / 3) * 4;

        // name → inline value text for the safe <data> entries only. Unsafe entries are recorded as refused so a
        // lookup returns null deterministically rather than "absent".
        private readonly Dictionary<string, ResxEntry> _safeEntries = new Dictionary<string, ResxEntry>(StringComparer.Ordinal);
        private readonly HashSet<string> _refused = new HashSet<string>(StringComparer.Ordinal);

        private SafeResxResolver() { }

        /// <summary>Parse .resx XML into a safe resolver. Malformed XML yields an empty resolver (every lookup null →
        /// fail closed), never a throw. A binary/SOAP/mimetyped/ResXFileRef/untrusted typed node is REFUSED
        /// (recorded, never materialized).</summary>
        public static SafeResxResolver Parse(string? resxXml)
        {
            return Parse(resxXml, null);
        }

        /// <summary>Parse a neutral .resx plus an optional culture-specific overlay. Culture entries replace neutral
        /// entries by exact key; absent culture entries fall back to neutral. A refused culture entry also replaces a
        /// safe neutral value, matching ResourceManager's "this key exists in the satellite" precedence while still
        /// failing closed for unsafe payloads.</summary>
        public static SafeResxResolver Parse(string? neutralXml, string? cultureXml)
        {
            var r = new SafeResxResolver();
            r.Merge(neutralXml);
            r.Merge(cultureXml);
            return r;
        }

        private void Merge(string? resxXml)
        {
            if (string.IsNullOrEmpty(resxXml)) return;
            XmlDocument doc;
            try
            {
                doc = new XmlDocument { XmlResolver = null }; // never resolve external entities (XXE)
                doc.LoadXml(resxXml);
            }
            catch { return; } // malformed overlay contributes nothing (fail closed on missing keys)

            foreach (XmlNode node in doc.GetElementsByTagName("data"))
            {
                var name = node.Attributes?["name"]?.Value;
                if (string.IsNullOrEmpty(name)) continue;
                var mimetype = node.Attributes?["mimetype"]?.Value;
                var type = node.Attributes?["type"]?.Value;

                // REFUSE: every mimetyped value except the raw byte-array MIME produced by the localized editor for
                // an explicitly typed Image/Bitmap/Icon. Binary/SOAP serialized objects, ResXFileRef (external file),
                // ImageListStreamer, and every unallowlisted type remain closed.
                bool safeByteArrayImage = IsSafeByteArrayImage(mimetype, type);
                if ((!string.IsNullOrEmpty(mimetype) && !safeByteArrayImage) ||
                    (!string.IsNullOrEmpty(type) && !IsSafeValueType(type!)))
                {
                    _safeEntries.Remove(name!);
                    _refused.Add(name!);
                    continue;
                }

                var valueNode = FirstChildElement(node, "value");
                var typeName = TypeNameOnly(type);
                _refused.Remove(name!);
                _safeEntries[name!] = new ResxEntry(valueNode?.InnerText ?? "", typeName, IsPlainStringType(type));
            }
        }

        /// <summary>Resolve a `resources.GetObject/GetString(key)`. Returns the inline string for a safe string node;
        /// null for a refused (binary/typed/file-ref) node OR an absent key — both make the owning statement fall
        /// back. `isString` is advisory; a safe node is always a string here (objects are never materialized).</summary>
        public object? Resolve(string key, bool isString)
        {
            if (key == null) return null;
            if (_safeEntries.TryGetValue(key, out var entry) && entry.IsStringCompatible) return entry.Value;
            if (!isString && _safeEntries.TryGetValue(key, out entry))
            {
                var type = SafeTypeByName(entry.TypeName);
                if (type != null && TryConvertInvariant(entry.Value, type, out var value, out _)) return value;
            }
            return null; // refused or absent → fail closed
        }

        /// <summary>True when the resolver deliberately refused <paramref name="key"/> (a binary/typed/file-ref node)
        /// — lets the caller report the precise `unsafeBinaryResource` reason rather than a generic "absent".</summary>
        public bool WasRefused(string key) => key != null && _refused.Contains(key);

        /// <summary>Apply every safe `<data name='key.Property'>value</data>` entry to <paramref name="target"/> via
        /// TypeDescriptor. The only materialized types are a small allowlist of framework value/property types, and all
        /// conversions use invariant strings. Any refused matching key, missing/read-only property, unallowlisted
        /// property type, or conversion error fails the whole capability.</summary>
        public bool ApplyResources(object target, string key, out string? error)
        {
            error = null;
            if (target == null) { error = "ApplyResources target is null"; return false; }
            if (string.IsNullOrEmpty(key)) { error = "ApplyResources key is empty"; return false; }

            string prefix = key + ".";
            foreach (var refused in _refused)
            {
                if (refused.StartsWith(prefix, StringComparison.Ordinal))
                {
                    error = "UNSAFE_RESOURCE: '" + refused + "' is a refused binary/SOAP/file-ref resource";
                    return false;
                }
            }

            var props = TypeDescriptor.GetProperties(target);
            foreach (var kv in _safeEntries)
            {
                if (!kv.Key.StartsWith(prefix, StringComparison.Ordinal)) continue;
                string propertyName = kv.Key.Substring(prefix.Length);
                if (propertyName.Length == 0 || propertyName.IndexOf('.') >= 0)
                {
                    error = "invalid ApplyResources property key '" + kv.Key + "'";
                    return false;
                }

                var pd = props[propertyName];
                if (pd == null)
                {
                    error = "ApplyResources property '" + propertyName + "' not found on " + target.GetType().Name;
                    return false;
                }
                if (pd.IsReadOnly)
                {
                    error = "ApplyResources property '" + propertyName + "' is read-only";
                    return false;
                }
                if (!IsApplyResourcesPropertyType(pd.PropertyType))
                {
                    error = "ApplyResources property type not allowed: " + pd.PropertyType.FullName;
                    return false;
                }
                if (!TryConvertInvariant(kv.Value.Value, pd.PropertyType, out var value, out error))
                {
                    error = "ApplyResources conversion failed for '" + kv.Key + "': " + error;
                    return false;
                }
                pd.SetValue(target, value);
            }
            return true;
        }

        private sealed class ResxEntry
        {
            public readonly string Value;
            public readonly string TypeName;
            public readonly bool IsStringCompatible;
            public ResxEntry(string value, string typeName, bool isStringCompatible)
            {
                Value = value;
                TypeName = typeName;
                IsStringCompatible = isStringCompatible;
            }
        }

        private static bool TryConvertInvariant(string text, Type targetType, out object? value, out string? error)
        {
            value = null;
            error = null;
            try
            {
                if (targetType == typeof(string)) { value = text; return true; }
                if (targetType.IsEnum) { value = Enum.Parse(targetType, text, ignoreCase: false); return true; }
                if (targetType == typeof(Image) || targetType == typeof(Bitmap))
                {
                    if (!TryDecodeImageBytes(text, out var bytes, out error)) return false;
                    using (var ms = new MemoryStream(bytes))
                    using (var img = Image.FromStream(ms, useEmbeddedColorManagement: false, validateImageData: true))
                    {
                        if (!HasSafeDimensions(img.Width, img.Height))
                        {
                            error = "image dimensions exceed safety limits";
                            return false;
                        }
                        value = new Bitmap(img);
                    }
                    return true;
                }
                if (targetType == typeof(Icon))
                {
                    if (!TryDecodeImageBytes(text, out var bytes, out error)) return false;
                    using (var ms = new MemoryStream(bytes))
                    using (var icon = new Icon(ms))
                    {
                        if (!HasSafeDimensions(icon.Width, icon.Height))
                        {
                            error = "icon dimensions exceed safety limits";
                            return false;
                        }
                        value = (Icon)icon.Clone();
                    }
                    return true;
                }
                var converter = TypeDescriptor.GetConverter(targetType);
                if (converter == null || !converter.CanConvertFrom(typeof(string)))
                {
                    error = "no invariant string converter for " + targetType.FullName;
                    return false;
                }
                value = converter.ConvertFromInvariantString(text);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.GetType().Name;
                return false;
            }
        }

        private static readonly HashSet<string> SafeValueTypeNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "System.String",
            "System.Boolean",
            "System.Byte",
            "System.SByte",
            "System.Int16",
            "System.UInt16",
            "System.Int32",
            "System.UInt32",
            "System.Int64",
            "System.UInt64",
            "System.Single",
            "System.Double",
            "System.Decimal",
            "System.Drawing.Point",
            "System.Drawing.Size",
            "System.Drawing.SizeF",
            "System.Drawing.Rectangle",
            "System.Drawing.Color",
            "System.Drawing.Font",
            "System.Drawing.Image",
            "System.Drawing.Bitmap",
            "System.Drawing.Icon",
            "System.Windows.Forms.Padding",
            "System.Windows.Forms.RightToLeft",
            "System.Windows.Forms.AnchorStyles",
            "System.Windows.Forms.DockStyle",
            "System.Windows.Forms.FlatStyle",
            "System.Drawing.ContentAlignment",
        };

        private static bool IsSafeValueType(string typeAttr)
        {
            if (IsPlainStringType(typeAttr)) return true;
            var name = TypeNameOnly(typeAttr);
            return SafeValueTypeNames.Contains(name);
        }

        private static bool IsSafeByteArrayImage(string? mimetype, string? typeAttr)
        {
            if (!string.Equals(mimetype, ByteArrayBase64Mime, StringComparison.Ordinal)) return false;
            string name = TypeNameOnly(typeAttr);
            return name == "System.Drawing.Image" || name == "System.Drawing.Bitmap" || name == "System.Drawing.Icon";
        }

        private static bool TryDecodeImageBytes(string text, out byte[] bytes, out string? error)
        {
            bytes = Array.Empty<byte>();
            error = null;
            if (text == null || text.Length == 0)
            {
                error = "image payload is empty";
                return false;
            }
            if (text.Length > MaxImageBase64Chars)
            {
                error = "image payload exceeds the encoded-size safety limit";
                return false;
            }
            bytes = Convert.FromBase64String(text);
            if (bytes.Length == 0 || bytes.Length > MaxImageBytes)
            {
                bytes = Array.Empty<byte>();
                error = "image payload exceeds the decoded-size safety limit";
                return false;
            }
            return true;
        }

        private static bool HasSafeDimensions(int width, int height)
        {
            return width > 0 && height > 0 &&
                   width <= MaxImageDimension && height <= MaxImageDimension &&
                   (long)width * height <= MaxImagePixels;
        }

        private static bool IsApplyResourcesPropertyType(Type type)
        {
            var name = type.FullName;
            return name != null && SafeValueTypeNames.Contains(name);
        }

        private static Type? SafeTypeByName(string typeName)
        {
            switch (typeName)
            {
                case "System.String": return typeof(string);
                case "System.Boolean": return typeof(bool);
                case "System.Byte": return typeof(byte);
                case "System.SByte": return typeof(sbyte);
                case "System.Int16": return typeof(short);
                case "System.UInt16": return typeof(ushort);
                case "System.Int32": return typeof(int);
                case "System.UInt32": return typeof(uint);
                case "System.Int64": return typeof(long);
                case "System.UInt64": return typeof(ulong);
                case "System.Single": return typeof(float);
                case "System.Double": return typeof(double);
                case "System.Decimal": return typeof(decimal);
                case "System.Drawing.Point": return typeof(Point);
                case "System.Drawing.Size": return typeof(Size);
                case "System.Drawing.SizeF": return typeof(SizeF);
                case "System.Drawing.Rectangle": return typeof(Rectangle);
                case "System.Drawing.Color": return typeof(Color);
                case "System.Drawing.Font": return typeof(Font);
                case "System.Drawing.Image": return typeof(Image);
                case "System.Drawing.Bitmap": return typeof(Bitmap);
                case "System.Drawing.Icon": return typeof(Icon);
                case "System.Windows.Forms.Padding": return typeof(System.Windows.Forms.Padding);
                case "System.Windows.Forms.RightToLeft": return typeof(System.Windows.Forms.RightToLeft);
                case "System.Windows.Forms.AnchorStyles": return typeof(System.Windows.Forms.AnchorStyles);
                case "System.Windows.Forms.DockStyle": return typeof(System.Windows.Forms.DockStyle);
                case "System.Windows.Forms.FlatStyle": return typeof(System.Windows.Forms.FlatStyle);
                case "System.Drawing.ContentAlignment": return typeof(ContentAlignment);
                default: return null;
            }
        }

        private static bool IsPlainStringType(string? typeAttr)
        {
            if (string.IsNullOrWhiteSpace(typeAttr)) return true;
            return TypeNameOnly(typeAttr) == "System.String";
        }

        private static string TypeNameOnly(string? typeAttr)
        {
            if (string.IsNullOrWhiteSpace(typeAttr)) return "System.String";
            // "System.String, mscorlib, …" — take the type name before the first comma.
            int comma = typeAttr.IndexOf(',');
            return (comma >= 0 ? typeAttr.Substring(0, comma) : typeAttr).Trim();
        }

        private static XmlNode? FirstChildElement(XmlNode parent, string localName)
        {
            foreach (XmlNode c in parent.ChildNodes)
                if (c.NodeType == XmlNodeType.Element && c.Name == localName) return c;
            return null;
        }
    }
}
