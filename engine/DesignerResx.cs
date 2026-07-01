using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel.Design;
using System.IO;
using System.Linq;
using System.Resources;
using System.Xml;
using System.Xml.Linq;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Loads a WinForms form's sibling <c>.resx</c> and resolves <c>resources.GetObject/GetString(name)</c>
    /// for the interpreter — the READ side of image/icon property support (BackgroundImage, PictureBox.Image,
    /// Form.Icon, …), which VS stores as <c>resources.GetObject("comp.Prop")</c> rather than an inline literal.
    ///
    /// SECURITY (this is a new deserialization + file-read surface fed by an attacker-influenced repo, so it is
    /// deliberately narrow, defense-in-depth):
    ///   • Nodes are read with <c>UseResXDataNodes = true</c> so nothing is materialized on load.
    ///   • A value materializes ONLY when its declared value-type is on <see cref="SafeTypes"/> — a strict
    ///     allowlist of TypeConverter-backed value types (images/icons/strings/primitives).
    ///   • BinaryFormatter/SOAP-serialized nodes (mimetype application/x-microsoft.net.object.binary.base64 /
    ///     .soap.base64) are refused by an explicit mimetype pre-scan (<see cref="_binaryKeys"/>) BEFORE any
    ///     GetValue — so the refusal does NOT rely on the .NET 9 runtime having removed BinaryFormatter (though
    ///     it also would throw there). This keeps the guard correct if the engine is ever retargeted.
    ///   • <see cref="ResXDataNode.FileRef"/> entries (external file references) are refused — materializing one
    ///     reads an attacker-controllable path off disk. Only embedded (base64) resources are honored.
    ///   • The whole .resx is bounded: files over <see cref="MaxBytes"/> are skipped, and at most
    ///     <see cref="MaxNodes"/> entries are held — so a hostile giant .resx can't balloon memory on open.
    /// Any failure degrades to null: the property stays unset and the form still renders (never throws out).
    /// </summary>
    public sealed class ResxResolver
    {
        private const long MaxBytes = 64L * 1024 * 1024; // skip absurdly large .resx (DoS bound; forms are tiny)
        private const int MaxNodes = 20000;              // cap held entries (a real form has < ~100)
        private const long MaxImagePixels = 4096L * 4096L; // reject a materialized pixel-bomb image (~16.7M px / ~64MB @32bpp)
        private const int MaxImageDimension = 20000;       // and an absurd per-axis dimension

        private readonly Dictionary<string, ResXDataNode> _nodes = new(StringComparer.Ordinal);
        /// <summary>Resource names whose &lt;data&gt; carries a BinaryFormatter/SOAP mimetype — refused outright.</summary>
        private readonly HashSet<string> _binaryKeys = new(StringComparer.Ordinal);

        private ResxResolver() { }

        /// <summary>Load the .resx that sits beside a form's designer file (Foo.Designer.cs / Foo.cs → Foo.resx),
        /// or null when there is no sibling .resx / it can't be read / it exceeds the size bound. Fully guarded.</summary>
        public static ResxResolver? TryLoadForDesigner(string designerFilePath)
        {
            try
            {
                string? path = ResxPathFor(designerFilePath);
                if (path == null || !File.Exists(path)) return null;
                if (new FileInfo(path).Length > MaxBytes) return null; // DoS bound — refuse a giant file wholesale

                var r = new ResxResolver();
                r.ScanBinaryKeys(path);
                using var reader = new ResXResourceReader(path) { UseResXDataNodes = true };
                foreach (DictionaryEntry e in reader)
                {
                    if (e.Key is string k && e.Value is ResXDataNode node) r._nodes[k] = node;
                    if (r._nodes.Count >= MaxNodes) break; // cap held entries
                }
                return r._nodes.Count > 0 ? r : null;
            }
            catch { return null; }
        }

        /// <summary>Pre-scan the .resx XML (DTD/entity resolution disabled) for &lt;data&gt; entries with a
        /// BinaryFormatter/SOAP mimetype, so <see cref="GetObject"/> can refuse them without ever materializing.
        /// A failed scan is non-fatal — the allowlist + runtime guard still apply.</summary>
        private void ScanBinaryKeys(string path)
        {
            try
            {
                var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
                using var xr = XmlReader.Create(path, settings);
                var doc = XDocument.Load(xr);
                foreach (var data in doc.Root?.Elements("data") ?? Enumerable.Empty<XElement>())
                {
                    string? name = (string?)data.Attribute("name");
                    string? mime = (string?)data.Attribute("mimetype");
                    if (name != null && mime != null &&
                        (mime.IndexOf("binary.base64", StringComparison.OrdinalIgnoreCase) >= 0
                         || mime.IndexOf("soap.base64", StringComparison.OrdinalIgnoreCase) >= 0))
                    {
                        _binaryKeys.Add(name);
                    }
                }
            }
            catch { /* pre-scan is best-effort defense-in-depth */ }
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

        /// <summary>Value-type full names (assembly-qualified prefix, i.e. the part before the first comma) that
        /// may be materialized from a resx node. Only side-effect-free, TypeConverter-backed value types.</summary>
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
            "System.Drawing.Font",
        };

        /// <summary>Resolve <c>resources.GetObject(name)</c> to a safe materialized value, or null.</summary>
        public object? GetObject(string name)
        {
            if (!_nodes.TryGetValue(name, out var node)) return null;
            if (_binaryKeys.Contains(name)) return null; // BinaryFormatter/SOAP node → refuse without materializing
            try
            {
                if (node.FileRef != null) return null; // external file reference → refuse (arbitrary file read)
                string? typeName = node.GetValueTypeName((ITypeResolutionService?)null);
                if (typeName == null) return null;
                string shortName = typeName.Split(',')[0].Trim();
                if (!SafeTypes.Contains(shortName)) return null; // not an allowlisted safe value type
                object? value = node.GetValue((ITypeResolutionService?)null);
                // bound a materialized image/icon: a pixel-bomb entry (tiny base64, huge dimensions) decodes to a
                // multi-GB raster that would then be rendered onto the form + thumbnailed. Reject (and dispose) an
                // oversized one so it is never drawn → the property stays unset and the form still renders.
                if (value is System.Drawing.Image img
                    && ((long)img.Width * img.Height > MaxImagePixels || img.Width > MaxImageDimension || img.Height > MaxImageDimension))
                {
                    img.Dispose();
                    return null;
                }
                if (value is System.Drawing.Icon ico
                    && ((long)ico.Width * ico.Height > MaxImagePixels || ico.Width > MaxImageDimension || ico.Height > MaxImageDimension))
                {
                    ico.Dispose();
                    return null;
                }
                return value;
            }
            catch { return null; } // unresolvable / bad bytes / (retarget) binary → degrade to null
        }

        /// <summary>Resolve <c>resources.GetString(name)</c> to a string, or null.</summary>
        public string? GetString(string name) => GetObject(name) as string;
    }
}
