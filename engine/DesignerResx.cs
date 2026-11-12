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
    /// Safe read-side resolver for sibling WinForms .resx files, for the modern engine. It overlays the neutral -> parent
    /// culture -> exact culture chain by key and serves values only through <see cref="SafeResxResolver"/>: pure XML, a
    /// fixed registry of trusted types, never a type or converter the input names.
    /// </summary>
    public sealed class ResxResolver
    {
        private const long MaxBytes = 64L * 1024 * 1024;
        private const int MaxNodes = 20000;
        private const int MaxScanNodes = 200000;

        private readonly SafeResxResolver _core;

        private ResxResolver(SafeResxResolver core) => _core = core;

        public static ResxResolver? TryLoadForDesigner(string designerFilePath)
            => TryLoadForDesigner(designerFilePath, DesignerCultureSelection.GetCultureName(designerFilePath));

        /// <summary>The form's resources, or null when it has no .resx (or one that cannot be read within the limits).
        /// An existing .resx without entries is an empty resource set, not a missing one.</summary>
        public static ResxResolver? TryLoadForDesigner(string designerFilePath, string? cultureName)
        {
            try
            {
                // Neutral first; a culture without its own .resx keeps its place as null, so the core knows whether the
                // neutral set a lookup ends in exists.
                var chain = new List<string?>();
                bool any = false;
                foreach (string path in ResxChainFor(designerFilePath, cultureName))
                {
                    if (!File.Exists(path)) { chain.Add(null); continue; }
                    if (new FileInfo(path).Length > MaxBytes) return null;
                    chain.Add(File.ReadAllText(path));
                    any = true;
                }
                if (!any) return null;
                var core = SafeResxResolver.ParseChain(chain, allowByteArrays: true, MaxNodes);
                // A .resx that is not well formed is no resource set: nothing is read from it, and nothing applied.
                return core.IsValid ? new ResxResolver(core) : null;
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
                    string? mimetype = xr.GetAttribute("mimetype");
                    string? type = xr.GetAttribute("type");
                    // A BinaryFormatter entry is served only for what its payload holds (an ImageListStreamer).
                    string? value = SafeResxResolver.IsBinaryFormatted(mimetype) ? ReadValue(xr) : null;
                    byKey[name] = !SafeResxResolver.IsServable(mimetype, type, value, allowByteArrays: true);
                }
                return byKey;
            }
            catch { return null; }
        }

        /// <summary>The text of the current &lt;data&gt; element's &lt;value&gt;; the reader is left on that element's end.</summary>
        private static string? ReadValue(XmlReader xr)
        {
            using var sub = xr.ReadSubtree();
            while (sub.Read())
                if (sub.NodeType == XmlNodeType.Element && sub.LocalName == "value") return sub.ReadElementContentAsString();
            return null;
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

        /// <summary>The .resx files a load of this form reads for <paramref name="cultureName"/>, neutral first (some
        /// may not exist).</summary>
        internal static IEnumerable<string> DesignerResxChain(string designerFilePath, string? cultureName) =>
            ResxChainFor(designerFilePath, cultureName);

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

        /// <summary>What `resources.GetObject(name)` (or, with <paramref name="asString"/>, `GetString`) finds.</summary>
        public ResourceLookup Lookup(string name, bool asString, out object? value, out string? error)
            => _core.Lookup(name, asString, out value, out error);

        public object? GetObject(string name) => _core.Resolve(name, isString: false);

        public string? GetString(string name) => _core.Resolve(name, isString: true) as string;

        public bool ApplyResources(object target, string key) => _core.ApplyResources(target, key, out _);
    }
}
