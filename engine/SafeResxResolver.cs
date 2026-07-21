using System;
using System.Collections.Generic;
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
    // dangerous serializer.
    //
    // A full-trust child AppDomain is NOT a sandbox: safety here is REFUSAL, not containment. Parsing is pure XML
    // (System.Xml, both TFMs); no resource assembly is loaded, no type is activated.
    // ============================================================================================================
    public sealed class SafeResxResolver
    {
        // name → inline string value for the safe (plain) <data> entries only. Unsafe entries are recorded as refused
        // so a lookup returns null deterministically rather than "absent".
        private readonly Dictionary<string, string> _safeStrings = new Dictionary<string, string>(StringComparer.Ordinal);
        private readonly HashSet<string> _refused = new HashSet<string>(StringComparer.Ordinal);

        private SafeResxResolver() { }

        /// <summary>Parse .resx XML into a safe resolver. Malformed XML yields an empty resolver (every lookup null →
        /// fail closed), never a throw. A binary/SOAP/mimetyped/ResXFileRef/non-System.String-typed node is REFUSED
        /// (recorded, never materialized).</summary>
        public static SafeResxResolver Parse(string? resxXml)
        {
            var r = new SafeResxResolver();
            if (string.IsNullOrEmpty(resxXml)) return r;
            XmlDocument doc;
            try
            {
                doc = new XmlDocument { XmlResolver = null }; // never resolve external entities (XXE)
                doc.LoadXml(resxXml);
            }
            catch { return r; } // malformed → empty (fail closed)

            foreach (XmlNode node in doc.GetElementsByTagName("data"))
            {
                var name = node.Attributes?["name"]?.Value;
                if (string.IsNullOrEmpty(name)) continue;
                var mimetype = node.Attributes?["mimetype"]?.Value;
                var type = node.Attributes?["type"]?.Value;

                // REFUSE: any binary/SOAP payload (mimetype present), or a typed node that is not the plain string
                // type — this covers ResXFileRef (external file), ImageListStreamer, serialized objects, everything
                // BinaryFormatter/BinaryFormatter-adjacent. Only an untyped, un-mimetyped inline value is a safe string.
                if (!string.IsNullOrEmpty(mimetype)) { r._refused.Add(name!); continue; }
                if (!string.IsNullOrEmpty(type) && !IsPlainStringType(type!)) { r._refused.Add(name!); continue; }

                var valueNode = FirstChildElement(node, "value");
                r._safeStrings[name!] = valueNode?.InnerText ?? "";
            }
            return r;
        }

        /// <summary>Resolve a `resources.GetObject/GetString(key)`. Returns the inline string for a safe string node;
        /// null for a refused (binary/typed/file-ref) node OR an absent key — both make the owning statement fall
        /// back. `isString` is advisory; a safe node is always a string here (objects are never materialized).</summary>
        public object? Resolve(string key, bool isString)
        {
            if (key == null) return null;
            if (_safeStrings.TryGetValue(key, out var s)) return s;
            return null; // refused or absent → fail closed
        }

        /// <summary>True when the resolver deliberately refused <paramref name="key"/> (a binary/typed/file-ref node)
        /// — lets the caller report the precise `unsafeBinaryResource` reason rather than a generic "absent".</summary>
        public bool WasRefused(string key) => key != null && _refused.Contains(key);

        private static bool IsPlainStringType(string typeAttr)
        {
            // "System.String, mscorlib, …" — take the type name before the first comma.
            int comma = typeAttr.IndexOf(',');
            var name = (comma >= 0 ? typeAttr.Substring(0, comma) : typeAttr).Trim();
            return name == "System.String";
        }

        private static XmlNode? FirstChildElement(XmlNode parent, string localName)
        {
            foreach (XmlNode c in parent.ChildNodes)
                if (c.NodeType == XmlNodeType.Element && c.Name == localName) return c;
            return null;
        }
    }
}
