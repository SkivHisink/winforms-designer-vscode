using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Resources;
using System.Xml;
using System.Xml.Linq;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Safe read-side resolver for sibling WinForms .resx files. It never materializes nodes during load, overlays the
    /// neutral -> parent culture -> exact culture chain by key, and materializes only a narrow allowlist of values.
    /// </summary>
    public sealed class ResxResolver
    {
        private const long MaxBytes = 64L * 1024 * 1024;
        private const int MaxNodes = 20000;
        private const int MaxScanNodes = 200000;
        private const long MaxImagePixels = 4096L * 4096L;
        private const int MaxImageDimension = 20000;

        private readonly Dictionary<string, ResXDataNode> _nodes = new(StringComparer.Ordinal);
        private readonly HashSet<string> _binaryKeys = new(StringComparer.Ordinal);

        private ResxResolver() { }

        public static ResxResolver? TryLoadForDesigner(string designerFilePath)
            => TryLoadForDesigner(designerFilePath, DesignerCultureSelection.GetCultureName(designerFilePath));

        public static ResxResolver? TryLoadForDesigner(string designerFilePath, string? cultureName)
        {
            try
            {
                var r = new ResxResolver();
                foreach (string path in ResxChainFor(designerFilePath, cultureName))
                {
                    if (!File.Exists(path)) continue;
                    if (new FileInfo(path).Length > MaxBytes) return null;
                    r.LoadIntoOverlay(path);
                    if (r._nodes.Count >= MaxNodes) break;
                }
                return r._nodes.Count > 0 ? r : null;
            }
            catch { return null; }
        }

        public static int UnrenderableResourceCount(string designerFilePath)
            => UnrenderableResourceCount(designerFilePath, DesignerCultureSelection.GetCultureName(designerFilePath));

        public static int UnrenderableResourceCount(string designerFilePath, string? cultureName)
        {
            Dictionary<string, bool> unsafeByKey = new(StringComparer.Ordinal);
            bool scanFailed = false;
            List<string> paths;
            try { paths = ResxChainFor(designerFilePath, cultureName).ToList(); }
            catch { return 0; }

            foreach (string path in paths)
            {
                if (!File.Exists(path)) continue;
                var scan = ScanUnrenderableMeta(path);
                if (scan == null)
                {
                    scanFailed = true;
                    continue;
                }
                foreach (var kv in scan) unsafeByKey[kv.Key] = kv.Value;
            }

            int n = unsafeByKey.Count(kv => kv.Value);
            return scanFailed ? Math.Max(n, 1) : n;
        }

        private static Dictionary<string, bool>? ScanUnrenderableMeta(string path)
        {
            try
            {
                var settings = new XmlReaderSettings
                {
                    DtdProcessing = DtdProcessing.Prohibit,
                    XmlResolver = null,
                    IgnoreComments = true,
                    IgnoreProcessingInstructions = true,
                };
                using var xr = XmlReader.Create(path, settings);
                var byKey = new Dictionary<string, bool>(StringComparer.Ordinal);
                int seen = 0;
                while (xr.Read())
                {
                    if (xr.NodeType != XmlNodeType.Element || xr.LocalName != "data") continue;
                    string? name = xr.GetAttribute("name");
                    if (name == null) continue;
                    if (++seen > MaxScanNodes)
                    {
                        byKey["__scan_cap__"] = true;
                        return byKey;
                    }
                    byKey[name] = IsUnrenderableMeta(xr.GetAttribute("mimetype"), xr.GetAttribute("type"));
                }
                return byKey;
            }
            catch { return null; }
        }

        private static bool IsUnrenderableMeta(string? mimetype, string? type)
        {
            if (mimetype != null && (mimetype.IndexOf("binary.base64", StringComparison.OrdinalIgnoreCase) >= 0
                                  || mimetype.IndexOf("soap.base64", StringComparison.OrdinalIgnoreCase) >= 0)) return true;
            if (type == null) return false;
            string shortName = type.Split(',')[0].Trim();
            if (shortName == "System.Resources.ResXFileRef") return true;
            return !SafeTypes.Contains(shortName) && !IsSafeEnum(shortName);
        }

        private void LoadIntoOverlay(string path)
        {
            var binaryKeys = ScanBinaryKeys(path);
            using var reader = new ResXResourceReader(path) { UseResXDataNodes = true };
            foreach (DictionaryEntry e in reader)
            {
                if (e.Key is string k && e.Value is ResXDataNode node)
                {
                    _nodes[k] = node;
                    if (binaryKeys.Contains(k)) _binaryKeys.Add(k);
                    else _binaryKeys.Remove(k);
                }
                if (_nodes.Count >= MaxNodes) break;
            }
        }

        private static HashSet<string> ScanBinaryKeys(string path)
        {
            var keys = new HashSet<string>(StringComparer.Ordinal);
            try
            {
                var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
                using var xr = XmlReader.Create(path, settings);
                var doc = XDocument.Load(xr);
                foreach (var data in doc.Descendants().Where(e => e.Name.LocalName == "data"))
                {
                    string? name = (string?)data.Attribute("name");
                    string? mime = (string?)data.Attribute("mimetype");
                    if (name != null && mime != null &&
                        (mime.IndexOf("binary.base64", StringComparison.OrdinalIgnoreCase) >= 0
                         || mime.IndexOf("soap.base64", StringComparison.OrdinalIgnoreCase) >= 0))
                    {
                        keys.Add(name);
                    }
                }
            }
            catch { }
            return keys;
        }

        private static string? ResxPathFor(string designerFilePath)
        {
            string dir = Path.GetDirectoryName(designerFilePath) ?? ".";
            string name = Path.GetFileName(designerFilePath);
            string @base;
            if (name.EndsWith(".Designer.cs", StringComparison.OrdinalIgnoreCase))
                @base = name.Substring(0, name.Length - ".Designer.cs".Length);
            else if (name.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                @base = name.Substring(0, name.Length - ".cs".Length);
            else return null;
            return Path.Combine(dir, @base + ".resx");
        }

        private static IEnumerable<string> ResxChainFor(string designerFilePath, string? cultureName)
        {
            string? neutralPath = ResxPathFor(designerFilePath);
            if (neutralPath == null) yield break;
            yield return neutralPath;
            if (!DesignerCultureSelection.TryNormalizeCultureName(cultureName, out var normalized, out _) || normalized.Length == 0)
                yield break;

            var culture = CultureInfo.GetCultureInfo(normalized);
            var cultures = new Stack<CultureInfo>();
            for (var c = culture; !c.Equals(CultureInfo.InvariantCulture); c = c.Parent) cultures.Push(c);
            string dir = Path.GetDirectoryName(neutralPath) ?? ".";
            string stem = Path.GetFileNameWithoutExtension(neutralPath);
            while (cultures.Count > 0)
            {
                var c = cultures.Pop();
                yield return Path.Combine(dir, stem + "." + c.Name + ".resx");
            }
        }

        private static readonly HashSet<string> SafeTypes = new(StringComparer.Ordinal)
        {
            "System.Drawing.Bitmap",
            "System.Drawing.Image",
            "System.Drawing.Icon",
            "System.String",
            "System.Byte[]",
            "System.Drawing.Color",
            "System.Drawing.Point",
            "System.Drawing.Size",
            "System.Drawing.SizeF",
            "System.Drawing.Rectangle",
            "System.Drawing.Font",
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
            "System.Windows.Forms.Padding",
            "System.Windows.Forms.RightToLeft",
            "System.Windows.Forms.AnchorStyles",
            "System.Windows.Forms.DockStyle",
            "System.Windows.Forms.FlatStyle",
            "System.Drawing.ContentAlignment",
        };

        public object? GetObject(string name) => TryGetObject(name, out var value) ? value : null;

        private bool TryGetObject(string name, out object? value)
        {
            value = null;
            if (!_nodes.TryGetValue(name, out var node)) return false;
            return TryMaterialize(name, node, out value);
        }

        private bool TryMaterialize(string name, ResXDataNode node, out object? value)
        {
            value = null;
            if (_binaryKeys.Contains(name)) return false;
            try
            {
                if (node.FileRef != null) return false;
                string? typeName = node.GetValueTypeName((ITypeResolutionService?)null);
                if (typeName == null) return false;
                string shortName = typeName.Split(',')[0].Trim();
                if (!SafeTypes.Contains(shortName) && !IsSafeEnum(shortName)) return false;
                value = node.GetValue((ITypeResolutionService?)null);
                if (value is System.Drawing.Image img
                    && ((long)img.Width * img.Height > MaxImagePixels || img.Width > MaxImageDimension || img.Height > MaxImageDimension))
                {
                    img.Dispose();
                    value = null;
                    return false;
                }
                if (value is System.Drawing.Icon ico
                    && ((long)ico.Width * ico.Height > MaxImagePixels || ico.Width > MaxImageDimension || ico.Height > MaxImageDimension))
                {
                    ico.Dispose();
                    value = null;
                    return false;
                }
                return true;
            }
            catch { value = null; return false; }
        }

        private static bool IsSafeEnum(string shortName) =>
            shortName == "System.Windows.Forms.RightToLeft"
            || shortName == "System.Windows.Forms.AnchorStyles"
            || shortName == "System.Windows.Forms.DockStyle"
            || shortName == "System.Windows.Forms.FlatStyle"
            || shortName == "System.Drawing.ContentAlignment";

        public string? GetString(string name) => GetObject(name) as string;

        public bool ApplyResources(object target, string key)
        {
            string prefix = key + ".";
            var pending = new List<(PropertyDescriptor pd, object? value)>();
            foreach (var kv in _nodes.Where(kv => kv.Key.StartsWith(prefix, StringComparison.Ordinal)))
            {
                string prop = kv.Key.Substring(prefix.Length);
                if (prop.Length == 0 || prop.IndexOf('.') >= 0) return false;
                if (!TryMaterialize(kv.Key, kv.Value, out var value)) return false;
                var pd = TypeDescriptor.GetProperties(target)[prop];
                if (pd == null || pd.IsReadOnly) return false;
                if (!TryCoerceForProperty(value, pd.PropertyType, out var coerced)) return false;
                pending.Add((pd, coerced));
            }

            foreach (var item in pending)
            {
                try { item.pd.SetValue(target, item.value); }
                catch { return false; }
            }
            return true;
        }

        private static bool TryCoerceForProperty(object? value, Type propertyType, out object? coerced)
        {
            coerced = value;
            if (value == null) return !propertyType.IsValueType || Nullable.GetUnderlyingType(propertyType) != null;
            if (propertyType.IsInstanceOfType(value)) return true;
            try
            {
                var target = Nullable.GetUnderlyingType(propertyType) ?? propertyType;
                if (value is string s)
                {
                    if (target.IsEnum)
                    {
                        coerced = Enum.Parse(target, s);
                        return true;
                    }
                    var converter = TypeDescriptor.GetConverter(target);
                    if (converter.CanConvertFrom(typeof(string)))
                    {
                        coerced = converter.ConvertFromInvariantString(s);
                        return true;
                    }
                }
                if (value is IConvertible)
                {
                    coerced = Convert.ChangeType(value, target, CultureInfo.InvariantCulture);
                    return true;
                }
            }
            catch { return false; }
            return false;
        }
    }
}
