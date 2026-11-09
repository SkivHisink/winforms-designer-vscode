using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Xml;

namespace WinFormsDesigner.Engine
{
    /// <summary>What a resource lookup found.</summary>
    public enum ResourceLookup
    {
        /// <summary>The key is not in the resources: <c>ResourceManager</c> returns null.</summary>
        Missing,
        /// <summary>The entry's value, materialized as its declared type.</summary>
        Value,
        /// <summary>A binary/SOAP/file-reference/untrusted-type entry: never materialized.</summary>
        Refused,
        /// <summary>A string lookup (<c>GetString</c>) of an entry that holds another type: <c>ResourceManager</c>
        /// throws.</summary>
        NotString,
        /// <summary>A trusted entry whose text does not convert to its declared type.</summary>
        Failed,
    }

    // ============================================================================================================
    // The SAFE .resx resolver, shared by the modern engine (through ResxResolver) and the .NET Framework engine. The
    // sibling .resx is repository-controlled input, and BinaryFormatter cannot be made safe for untrusted input on ANY
    // .NET version, so a binary/SOAP payload or a ResXFileRef is NEVER deserialized: it is recorded as refused.
    //
    // Parsing is pure XML; no resource assembly is loaded and no type is resolved from the input. A typed entry is
    // served only when its type attribute names a type of the fixed registry below, in an assembly of that type's own
    // name (or a framework alias of it). The value is then made from the invariant text by the converter of the
    // registry's own Type object — never the converter of a type the input or a control's property names, so a
    // project type that calls itself `System.Drawing.Point` runs nothing. Images and icons accept only the raw
    // byte-array MIME (or plain base64 text), with strict decoded-size and dimension limits.
    //
    // ApplyResources applies an entry's value, materialized as its declared type, only to a property that takes that
    // value as it is — as ComponentResourceManager does; a value of another type is refused instead of converted. Every
    // matching entry is checked before any property is set.
    //
    // A full-trust child AppDomain is NOT a sandbox: safety here is REFUSAL, not containment.
    // ============================================================================================================
    public sealed class SafeResxResolver
    {
        private const string ByteArrayBase64Mime = "application/x-microsoft.net.object.bytearray.base64";
        private const int MaxImageBytes = 16 * 1024 * 1024;
        private const int MaxImageDimension = 20000;
        private const long MaxImagePixels = 4096L * 4096L;
        private const int MaxImageBase64Chars = ((MaxImageBytes + 2) / 3) * 4;

        private enum EntryKind { String, Scalar, Image, Icon, Bytes }

        // name → entry, for the servable <data> entries only. Unsafe entries are recorded as refused so a lookup reports
        // them deterministically rather than as absent.
        private readonly Dictionary<string, ResxEntry> _safeEntries = new Dictionary<string, ResxEntry>(StringComparer.Ordinal);
        private readonly HashSet<string> _refused = new HashSet<string>(StringComparer.Ordinal);
        private readonly bool _allowByteArrays;
        private readonly int _maxEntries;
        // How many documents were read, and whether every one was a well-formed .resx: with none, or with a broken one,
        // there is no resource set the compiled form could have embedded.
        private int _documents;
        private bool _valid = true;
        // Whether the neutral .resx (the first of the chain) was read: ResourceManager ends every lookup there, and without
        // it a key no culture holds, or ApplyResources, throws MissingManifestResourceException.
        private bool _neutral;

        private SafeResxResolver(bool allowByteArrays, int maxEntries)
        {
            _allowByteArrays = allowByteArrays;
            _maxEntries = maxEntries;
        }

        /// <summary>Parse .resx XML into a safe resolver. Malformed XML yields an empty resolver (every lookup missing →
        /// fail closed), never a throw. A binary/SOAP/mimetyped/ResXFileRef/untrusted typed node is REFUSED.</summary>
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
            return ParseChain(new[] { neutralXml, cultureXml }, allowByteArrays: false);
        }

        /// <summary>Parse a chain of .resx documents, neutral first and the most specific culture last, each overlaying
        /// the ones before it by key. <paramref name="allowByteArrays"/> also serves raw <c>System.Byte[]</c> entries;
        /// at most <paramref name="maxEntries"/> keys are kept.</summary>
        public static SafeResxResolver ParseChain(IEnumerable<string?> chain, bool allowByteArrays, int maxEntries = int.MaxValue)
        {
            var r = new SafeResxResolver(allowByteArrays, maxEntries);
            bool first = true;
            foreach (var xml in chain)
            {
                bool read = r.Merge(xml);
                if (first) r._neutral = read;
                first = false;
            }
            return r;
        }

        /// <summary>Overlay one document; true when it was read as a well-formed .resx.</summary>
        private bool Merge(string? resxXml)
        {
            if (string.IsNullOrEmpty(resxXml)) return false;
            XmlDocument doc;
            try
            {
                doc = new XmlDocument { XmlResolver = null }; // never resolve external entities (XXE)
                doc.LoadXml(resxXml);
            }
            catch { _valid = false; return false; } // malformed: contributes nothing, and the set is not a valid one
            if (doc.DocumentElement == null || doc.DocumentElement.Name != "root") { _valid = false; return false; }
            _documents++;

            foreach (XmlNode node in doc.GetElementsByTagName("data"))
            {
                var name = node.Attributes?["name"]?.Value;
                if (string.IsNullOrEmpty(name)) continue;
                if (!_safeEntries.ContainsKey(name!) && !_refused.Contains(name!) && _safeEntries.Count + _refused.Count >= _maxEntries) break;
                var mimetype = node.Attributes?["mimetype"]?.Value;
                var type = node.Attributes?["type"]?.Value;

                if (!TryClassify(mimetype, type, _allowByteArrays, out var kind, out var declared))
                {
                    _safeEntries.Remove(name!);
                    _refused.Add(name!);
                    continue;
                }
                var valueNode = FirstChildElement(node, "value");
                _refused.Remove(name!);
                _safeEntries[name!] = new ResxEntry(valueNode?.InnerText ?? "", kind, declared);
            }
            return true;
        }

        /// <summary>Whether an entry with this <c>mimetype</c> and <c>type</c> attribute would be served (not refused).
        /// The count of unrenderable resources uses the same rule.</summary>
        public static bool IsServable(string? mimetype, string? type, bool allowByteArrays) =>
            TryClassify(mimetype, type, allowByteArrays, out _, out _);

        private static bool TryClassify(string? mimetype, string? typeAttr, bool allowByteArrays, out EntryKind kind, out Type declared)
        {
            kind = EntryKind.String;
            declared = typeof(string);
            bool hasMime = !string.IsNullOrEmpty(mimetype);
            if (string.IsNullOrWhiteSpace(typeAttr)) return !hasMime; // an untyped entry is a string; untyped MIME data is not served
            if (!TryTrustedType(typeAttr!, out var t)) return false;
            declared = t;
            if (t == typeof(Image) || t == typeof(Bitmap)) kind = EntryKind.Image;
            else if (t == typeof(Icon)) kind = EntryKind.Icon;
            else if (t == typeof(byte[]))
            {
                // The resource writer stores a byte array as typed base64 text; the byte-array MIME is accepted too.
                kind = EntryKind.Bytes;
                return allowByteArrays && (!hasMime || string.Equals(mimetype, ByteArrayBase64Mime, StringComparison.Ordinal));
            }
            else kind = t == typeof(string) ? EntryKind.String : EntryKind.Scalar;
            // Only an image or an icon may come as the raw byte-array MIME; every other MIME (binary, SOAP) is refused.
            return !hasMime || ((kind == EntryKind.Image || kind == EntryKind.Icon) && string.Equals(mimetype, ByteArrayBase64Mime, StringComparison.Ordinal));
        }

        /// <summary>What <c>resources.GetObject(key)</c> (<paramref name="asString"/> false) or <c>GetString(key)</c>
        /// finds, and the value for <see cref="ResourceLookup.Value"/>.</summary>
        public ResourceLookup Lookup(string key, bool asString, out object? value, out string? error)
        {
            value = null;
            error = null;
            if (key == null) return ResourceLookup.Missing;
            if (!_valid) { error = "the .resx is not well formed"; return ResourceLookup.Failed; }
            if (_refused.Contains(key)) return ResourceLookup.Refused;
            if (!_safeEntries.TryGetValue(key, out var entry))
            {
                if (HasResourceSet) return ResourceLookup.Missing;
                error = "the form has no neutral .resx for a key no culture holds";
                return ResourceLookup.Failed;
            }
            if (asString && entry.Kind != EntryKind.String) return ResourceLookup.NotString;
            return TryMaterialize(entry, out value, out error) ? ResourceLookup.Value : ResourceLookup.Failed;
        }

        /// <summary>Resolve a `resources.GetObject/GetString(key)`: the value of a served entry; null for a refused,
        /// absent, failed or (for a string lookup) non-string entry.</summary>
        public object? Resolve(string key, bool isString) =>
            Lookup(key, isString, out var value, out _) == ResourceLookup.Value ? value : null;

        /// <summary>True when the resolver deliberately refused <paramref name="key"/> (a binary/typed/file-ref node)
        /// — lets the caller report the precise `unsafeBinaryResource` reason rather than a generic "absent".</summary>
        public bool WasRefused(string key) => key != null && _refused.Contains(key);

        /// <summary>Whether every document read was a well-formed .resx.</summary>
        public bool IsValid => _valid;

        /// <summary>Whether there is a resource set a lookup can end in: the neutral .resx read, every document well
        /// formed.</summary>
        public bool HasResourceSet => _valid && _neutral;

        /// <summary>True when the resources hold <paramref name="key"/>, served or refused.</summary>
        public bool HasResource(string key) => key != null && (_safeEntries.ContainsKey(key) || _refused.Contains(key));

        /// <summary>Apply every `<data name='key.Property'>` entry to <paramref name="target"/>. Every matching entry is
        /// checked first — a refused entry, a missing/read-only/nested property, a value that does not materialize, or a
        /// value the property does not take as it is — and the whole capability fails before any property is set.</summary>
        public bool ApplyResources(object target, string key, out string? error)
        {
            error = null;
            if (target == null) { error = "ApplyResources target is null"; return false; }
            if (string.IsNullOrEmpty(key)) { error = "ApplyResources key is empty"; return false; }
            // Without a resource set the compiled form throws MissingManifestResourceException; with a broken one it does
            // not build.
            if (!_valid) { error = "ApplyResources: the .resx is not well formed"; return false; }
            if (!_neutral) { error = "ApplyResources: the form has no .resx"; return false; }

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
            var pending = new List<KeyValuePair<PropertyDescriptor, object?>>();
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
                if (!TryMaterialize(kv.Value, out var value, out error))
                {
                    error = "ApplyResources conversion failed for '" + kv.Key + "': " + error;
                    return false;
                }
                // ComponentResourceManager sets a property only to a value of its type; a resource of another type is
                // not converted into one.
                bool fits = value == null
                    ? !pd.PropertyType.IsValueType || Nullable.GetUnderlyingType(pd.PropertyType) != null
                    : pd.PropertyType.IsInstanceOfType(value);
                if (!fits)
                {
                    error = "ApplyResources resource '" + kv.Key + "' of type " + kv.Value.Declared.FullName
                        + " does not fit property type " + pd.PropertyType.FullName;
                    return false;
                }
                pending.Add(new KeyValuePair<PropertyDescriptor, object?>(pd, value));
            }

            foreach (var item in pending)
            {
                try { item.Key.SetValue(target, item.Value); }
                catch (Exception ex)
                {
                    error = "ApplyResources failed to set '" + item.Key.Name + "': " + ex.GetType().Name;
                    return false;
                }
            }
            return true;
        }

        private sealed class ResxEntry
        {
            public readonly string Value;
            public readonly EntryKind Kind;
            public readonly Type Declared;
            public ResxEntry(string value, EntryKind kind, Type declared)
            {
                Value = value;
                Kind = kind;
                Declared = declared;
            }
        }

        private static bool TryMaterialize(ResxEntry entry, out object? value, out string? error)
        {
            value = null;
            error = null;
            try
            {
                switch (entry.Kind)
                {
                    case EntryKind.String:
                        value = entry.Value;
                        return true;
                    case EntryKind.Bytes:
                        if (!TryDecodeBytes(entry.Value, out var raw, out error)) return false;
                        value = raw;
                        return true;
                    case EntryKind.Image:
                        {
                            if (!TryDecodeImageBytes(entry.Value, out var bytes, out error)) return false;
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
                    case EntryKind.Icon:
                        {
                            if (!TryDecodeImageBytes(entry.Value, out var bytes, out error)) return false;
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
                    default:
                        {
                            // The registry's own Type: its framework converter reads the invariant text the resource
                            // writer wrote (`Ctrl+A` for Keys, `Top, Left` for a flags enum, `A` for a char).
                            var converter = TypeDescriptor.GetConverter(entry.Declared);
                            if (converter == null || !converter.CanConvertFrom(typeof(string)))
                            {
                                error = "no invariant string converter for " + entry.Declared.FullName;
                                return false;
                            }
                            value = converter.ConvertFromInvariantString(entry.Value);
                            if (value == null || value.GetType() != entry.Declared)
                            {
                                error = "the converter of " + entry.Declared.FullName + " made another type";
                                value = null;
                                return false;
                            }
                            return true;
                        }
                }
            }
            catch (Exception ex)
            {
                value = null;
                error = ex.GetType().Name;
                return false;
            }
        }

        // ------------------------------------------------------------------ the trusted registry ----------------------

        private static readonly string[] CoreLibraries = { "mscorlib", "System.Private.CoreLib", "netstandard", "System.Runtime" };
        private static readonly string[] DrawingPrimitives = { "System.Drawing", "System.Drawing.Primitives", "netstandard" };
        private static readonly string[] DrawingCommon = { "System.Drawing", "System.Drawing.Common" };
        private static readonly string[] WindowsForms = { "System.Windows.Forms", "System.Windows.Forms.Primitives" };

        /// <summary>Every type a resource may be materialized as, by full name, with the assembly names its type
        /// attribute may give. Fixed here; nothing in the input adds to it.</summary>
        private static readonly Dictionary<string, KeyValuePair<Type, string[]>> Trusted = BuildRegistry();

        private static Dictionary<string, KeyValuePair<Type, string[]>> BuildRegistry()
        {
            var map = new Dictionary<string, KeyValuePair<Type, string[]>>(StringComparer.Ordinal);
            void Add(Type? t, string[] assemblies)
            {
                if (t?.FullName == null) return;
                var names = new List<string>(assemblies);
                string own = t.Assembly.GetName().Name ?? "";
                if (own.Length > 0 && !names.Contains(own)) names.Add(own);
                map[t.FullName] = new KeyValuePair<Type, string[]>(t, names.ToArray());
            }
            foreach (var t in new[]
            {
                typeof(string), typeof(bool), typeof(char), typeof(byte), typeof(sbyte), typeof(short), typeof(ushort),
                typeof(int), typeof(uint), typeof(long), typeof(ulong), typeof(float), typeof(double), typeof(decimal),
                typeof(byte[]),
            }) Add(t, CoreLibraries);
            foreach (var t in new[]
            {
                typeof(Point), typeof(Size), typeof(SizeF), typeof(Rectangle), typeof(Color), typeof(ContentAlignment),
            }) Add(t, DrawingPrimitives);
            foreach (var t in new[] { typeof(Font), typeof(Image), typeof(Bitmap), typeof(Icon) }) Add(t, DrawingCommon);
            foreach (var t in new[]
            {
                typeof(System.Windows.Forms.Padding), typeof(System.Windows.Forms.RightToLeft),
                typeof(System.Windows.Forms.AnchorStyles), typeof(System.Windows.Forms.DockStyle),
                typeof(System.Windows.Forms.FlatStyle),
                // The scalar types of the properties Windows Forms marks Localizable, which a localized form's .resx
                // holds through ApplyResources or a cast of GetObject.
                typeof(System.Windows.Forms.Appearance), typeof(System.Windows.Forms.AutoSizeMode),
                typeof(System.Windows.Forms.Day), typeof(System.Windows.Forms.FlowDirection),
                typeof(System.Windows.Forms.FormStartPosition), typeof(System.Windows.Forms.HorizontalAlignment),
                typeof(System.Windows.Forms.ImageLayout), typeof(System.Windows.Forms.ImeMode),
                typeof(System.Windows.Forms.Keys), typeof(System.Windows.Forms.LeftRightAlignment),
                typeof(System.Windows.Forms.LinkArea), typeof(System.Windows.Forms.ListViewAlignment),
                typeof(System.Windows.Forms.Orientation), typeof(System.Windows.Forms.PictureBoxSizeMode),
                typeof(System.Windows.Forms.RichTextBoxScrollBars), typeof(System.Windows.Forms.ScrollBars),
                typeof(System.Windows.Forms.TabAlignment), typeof(System.Windows.Forms.TabAppearance),
                typeof(System.Windows.Forms.TableLayoutPanelCellBorderStyle), typeof(System.Windows.Forms.TextImageRelation),
                typeof(System.Windows.Forms.ToolStripItemImageScaling),
            }) Add(t, WindowsForms);
            // Types only some Windows Forms versions have (the classic menu and toolbar), looked up by a fixed name.
            foreach (var name in new[] { "System.Windows.Forms.Shortcut", "System.Windows.Forms.ToolBarAppearance", "System.Windows.Forms.ToolBarTextAlign" })
                Add(typeof(System.Windows.Forms.Control).Assembly.GetType(name, throwOnError: false), WindowsForms);
            return map;
        }

        /// <summary>The registry's Type for a <c>type</c> attribute ("Name, Assembly, Version=…"): the name must be in
        /// the registry and the assembly, when given, one that type may be written as. Nothing is loaded.</summary>
        private static bool TryTrustedType(string typeAttr, out Type type)
        {
            type = typeof(string);
            string[] parts = typeAttr.Split(',');
            string name = parts[0].Trim();
            if (!Trusted.TryGetValue(name, out var trusted)) return false;
            if (parts.Length > 1)
            {
                string assembly = parts[1].Trim();
                if (Array.FindIndex(trusted.Value, a => string.Equals(a, assembly, StringComparison.OrdinalIgnoreCase)) < 0) return false;
            }
            type = trusted.Key;
            return true;
        }

        // ------------------------------------------------------------------ helpers -----------------------------------

        private static bool TryDecodeImageBytes(string text, out byte[] bytes, out string? error)
        {
            bytes = Array.Empty<byte>();
            error = null;
            if (text == null || text.Length == 0)
            {
                error = "payload is empty";
                return false;
            }
            if (text.Length > MaxImageBase64Chars)
            {
                error = "payload exceeds the encoded-size safety limit";
                return false;
            }
            bytes = Convert.FromBase64String(text);
            if (bytes.Length == 0 || bytes.Length > MaxImageBytes)
            {
                bytes = Array.Empty<byte>();
                error = "payload exceeds the decoded-size safety limit";
                return false;
            }
            return true;
        }

        /// <summary>A byte array's base64 text, empty included, within the decoded-size limit.</summary>
        private static bool TryDecodeBytes(string text, out byte[] bytes, out string? error)
        {
            bytes = Array.Empty<byte>();
            error = null;
            string trimmed = (text ?? "").Trim();
            if (trimmed.Length > MaxImageBase64Chars)
            {
                error = "payload exceeds the encoded-size safety limit";
                return false;
            }
            bytes = Convert.FromBase64String(trimmed);
            return true;
        }

        private static bool HasSafeDimensions(int width, int height)
        {
            return width > 0 && height > 0 &&
                   width <= MaxImageDimension && height <= MaxImageDimension &&
                   (long)width * height <= MaxImagePixels;
        }

        private static XmlNode? FirstChildElement(XmlNode parent, string localName)
        {
            foreach (XmlNode c in parent.ChildNodes)
                if (c.NodeType == XmlNodeType.Element && c.Name == localName) return c;
            return null;
        }
    }
}
