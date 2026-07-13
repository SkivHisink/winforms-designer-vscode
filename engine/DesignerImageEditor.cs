using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>Result of <see cref="DesignerImageEditor.SetImageResource"/> — the WRITE side of image/icon
    /// property support ("Import…"). Carries BOTH the new .Designer.cs text (a resources local + the
    /// resources.GetObject assignment) and the new sibling .resx text (the embedded image), which the host
    /// applies together: the .resx to disk (a resource file, like VS), the designer as an undoable in-memory
    /// edit. Both are null when the edit is rejected.</summary>
    public sealed class ImageResourceResult
    {
        public bool Ok { get; init; }
        public EditMode Mode { get; init; }
        /// <summary>New .Designer.cs text (resources-local ensured + the assignment inserted/replaced), or null.</summary>
        public string? DesignerText { get; init; }
        /// <summary>New sibling .resx text with the image embedded (created from a skeleton if absent), or null.</summary>
        public string? ResxText { get; init; }
        /// <summary>The resx resource key written ("$this.Prop" for the form, "comp.Prop" for a child).</summary>
        public string ResxKey { get; init; } = "";
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// The write side of resx-backed image/icon properties (BackgroundImage, PictureBox.Image, Form.Icon…):
    /// embed a chosen image into the form's sibling <c>.resx</c> and emit the VS-idiomatic
    /// <c>this.x.Prop = ((System.Drawing.Image)(resources.GetObject("x.Prop")));</c> into InitializeComponent
    /// (ensuring the <c>ComponentResourceManager resources</c> local exists). The engine NEVER writes files —
    /// it computes both texts; the host persists them.
    ///
    /// SECURITY (this is a WRITE surface fed image bytes + component/property names from the UI):
    ///   • component id / property name must be valid C# identifiers ("this"/"" = the root form); the resx key
    ///     and the C# LHS/GetObject-literal are built ONLY from those validated tokens (no injection surface).
    ///   • the property's declared type must be on a strict allowlist (Image/Bitmap/Icon) — nothing else is
    ///     embeddable, so a hostile type name can't route bytes through an arbitrary converter.
    ///   • the image bytes must actually DECODE as the declared kind (GDI+ Image / Icon) and stay within a size
    ///     + dimension bound — arbitrary/oversized bytes are refused before anything is written.
    ///   • the .resx is manipulated as XML via <see cref="System.Xml.Linq"/> (values auto-escaped) with DTD /
    ///     entity resolution disabled; the base64 payload is <see cref="Convert.ToBase64String"/> output only.
    ///     An existing-but-unparseable .resx is REFUSED, never clobbered. BinaryFormatter nodes are round-tripped
    ///     as opaque text (never deserialized).
    ///   • the designer edit reuses the proven safe-save gates (<see cref="DesignerPropertyEditor.OnlyTargetChanged"/>
    ///     for the assignment; a focused local-only gate for the inserted resources declaration) + a parse check.
    /// Any failure returns Ok=false with a reason; nothing is written.
    /// </summary>
    public static class DesignerImageEditor
    {
        private const int MaxImageBytes = 16 * 1024 * 1024; // embedded images are small; 16MB is a generous DoS bound
        private const int MaxResxBytes = 64 * 1024 * 1024;  // matches ResxResolver's read cap
        private const int MaxDimension = 20000;             // reject absurd per-axis dimensions
        // Total decoded-raster bound (~16.7M px = ~64MB @32bpp). A pixel bomb (tiny encoded file declaring huge
        // dimensions on BOTH axes) stays under MaxImageBytes and MaxDimension yet decodes to gigabytes, so the
        // product must be bounded too — checked from a HEADER-only decode before the full raster is materialized.
        private const long MaxPixels = 4096L * 4096L;

        /// <summary>Declared property type → (resx value-type attribute, C# cast type, isIcon). The strict
        /// allowlist of embeddable image/icon property types.</summary>
        private static readonly Dictionary<string, (string ResxType, string Cast, bool IsIcon)> Kinds =
            new(StringComparer.Ordinal)
            {
                ["System.Drawing.Image"] = ("System.Drawing.Bitmap, System.Drawing.Common", "System.Drawing.Image", false),
                ["System.Drawing.Bitmap"] = ("System.Drawing.Bitmap, System.Drawing.Common", "System.Drawing.Bitmap", false),
                ["System.Drawing.Icon"] = ("System.Drawing.Icon, System.Drawing.Common", "System.Drawing.Icon", true),
            };

        /// <summary>Embed <paramref name="imageBytes"/> into the form's .resx and write the resources.GetObject
        /// assignment into <paramref name="designerSrc"/>. <paramref name="resxText"/> is the current sibling .resx
        /// content (null/empty ⇒ create from the standard skeleton). Returns the two new texts, or Ok=false.</summary>
        public static ImageResourceResult SetImageResource(
            string designerSrc, string componentId, string propertyName, string propertyTypeName,
            byte[] imageBytes, string? resxText)
        {
            bool isRoot = componentId is "this" or "";
            if (!isRoot && !DesignerControlEditor.IsValidIdentifier(componentId))
                return Fail("invalid component id: " + componentId);
            if (!DesignerControlEditor.IsValidIdentifier(propertyName))
                return Fail("invalid property name: " + propertyName);
            if (!Kinds.TryGetValue(propertyTypeName, out var kind))
                return Fail("not an embeddable image property type: " + propertyTypeName);
            if (imageBytes == null || imageBytes.Length == 0)
                return Fail("no image data");
            if (imageBytes.Length > MaxImageBytes)
                return Fail("image is too large (" + imageBytes.Length + " bytes; max " + MaxImageBytes + ")");
            if (resxText != null && resxText.Length > MaxResxBytes)
                return Fail("existing .resx is too large to modify safely");

            // the bytes must actually decode as the declared kind (and be within dimension bounds) — refuse
            // arbitrary / oversized / mismatched bytes before writing anything.
            string? decodeErr = ValidateImageBytes(imageBytes, kind.IsIcon);
            if (decodeErr != null) return Fail(decodeErr);

            // resx key: the form's own props use "$this.Prop"; a child's use "<compName>.Prop" (VS's exact naming).
            string key = isRoot ? "$this." + propertyName : componentId + "." + propertyName;

            string? newResx = ResxImageWriter.Upsert(resxText, key, kind.ResxType, Convert.ToBase64String(imageBytes));
            if (newResx == null)
                return Fail("the existing .resx is malformed and was not modified");

            // ---- designer edit: ensure the resources local, then insert/replace the assignment ----
            var init = FindInitializeComponent(designerSrc);
            if (init == null) return Fail("InitializeComponent not found");
            string? className = ClassNameOf(designerSrc);
            if (className == null) return Fail("could not find the form class");

            var (varName, afterLocal, insertedLocal) = EnsureResourcesLocal(designerSrc, className);
            if (varName == null) return Fail("could not place the resources declaration");
            if (insertedLocal && !OnlyResourcesLocalAdded(designerSrc, afterLocal, varName))
                return Fail("resources declaration edit changed more than intended");

            string rhs = "((" + kind.Cast + ")(" + varName + ".GetObject(\"" + key + "\")))";
            var edit = DesignerPropertyEditor.EditProperty(afterLocal, componentId, propertyName, rhs);
            if (edit.Mode == EditMode.Failed)
                return Fail(edit.Reason);

            bool parseOk = !CSharpSyntaxTree.ParseText(edit.NewText).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = DesignerPropertyEditor.OnlyTargetChanged(afterLocal, edit.NewText, componentId, propertyName, edit.Mode);
            if (!parseOk || !minimal)
                return Fail(!parseOk ? "edited designer text has syntax errors" : "edit changed more than the target property");

            return new ImageResourceResult
            {
                Ok = true,
                Mode = edit.Mode,
                DesignerText = edit.NewText,
                ResxText = newResx,
                ResxKey = key,
            };
        }

        private static ImageResourceResult Fail(string reason) =>
            new ImageResourceResult { Ok = false, Mode = EditMode.Failed, Reason = reason };

        /// <summary>Confirm the bytes decode as the declared kind (GDI+ Image / Icon) and are within the dimension
        /// AND total-pixel bounds. For images the declared dimensions are read from a HEADER-only decode
        /// (validateImageData:false — no full raster) FIRST, so an oversized pixel bomb is rejected before any
        /// large allocation; only within-bounds bytes are then fully validated. Returns null on success, else a
        /// reason. Fully guarded.</summary>
        private static string? ValidateImageBytes(byte[] bytes, bool isIcon)
        {
            try
            {
                using var ms = new MemoryStream(bytes, writable: false);
                if (isIcon)
                {
                    using var ico = new System.Drawing.Icon(ms);
                    if (ico.Width <= 0 || ico.Height <= 0 || ico.Width > MaxDimension || ico.Height > MaxDimension
                        || (long)ico.Width * ico.Height > MaxPixels)
                        return "icon dimensions are out of range";
                    return null;
                }
                // header-only decode: read the declared dimensions WITHOUT materializing the full raster, so a
                // pixel bomb (tiny file, huge dimensions) is rejected here before the raster is ever allocated.
                int w, h;
                using (var probe = System.Drawing.Image.FromStream(ms, useEmbeddedColorManagement: false, validateImageData: false))
                {
                    w = probe.Width; h = probe.Height;
                }
                if (w <= 0 || h <= 0 || w > MaxDimension || h > MaxDimension || (long)w * h > MaxPixels)
                    return "image dimensions are out of range";
                // within bounds → now fully validate the pixel data (the raster is bounded to MaxPixels).
                ms.Position = 0;
                using (var img = System.Drawing.Image.FromStream(ms, useEmbeddedColorManagement: false, validateImageData: true))
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

        /// <summary>Find (or insert) the <c>ComponentResourceManager</c> local in InitializeComponent. Returns the
        /// local's var name, the (possibly unchanged) source text, and whether a declaration was inserted. On the
        /// insert path the declaration is added as the FIRST body statement (VS's placement), named uniquely.</summary>
        internal static (string? varName, string text, bool inserted) EnsureResourcesLocal(string src, string className)
        {
            var init = FindInitializeComponent(src);
            if (init?.Body == null) return (null, src, false);

            // reuse an existing ComponentResourceManager local (VS always names it "resources") if present.
            foreach (var st in init.Body.Statements)
            {
                if (st is LocalDeclarationStatementSyntax lds
                    && LastTypeSegment(lds.Declaration.Type.ToString()) == "ComponentResourceManager")
                {
                    var first = lds.Declaration.Variables.FirstOrDefault();
                    if (first != null) return (first.Identifier.Text, src, false);
                }
            }

            // none — insert one. Pick a name not colliding with any field/local identifier.
            string varName = UniqueName("resources", src, init);
            string nl = src.Contains("\r\n") ? "\r\n" : "\n";
            var firstStmt = init.Body.Statements.FirstOrDefault();
            string indent;
            int insertPos;
            if (firstStmt != null)
            {
                indent = LeadingIndent(src, firstStmt.SpanStart);
                insertPos = LineStart(src, firstStmt.SpanStart);
            }
            else
            {
                indent = LeadingIndent(src, init.SpanStart) + "    ";
                int braceEnd = init.Body.OpenBraceToken.Span.End;
                int nlIdx = src.IndexOf('\n', braceEnd);
                insertPos = nlIdx < 0 ? braceEnd : nlIdx + 1;
            }
            string decl = indent + "System.ComponentModel.ComponentResourceManager " + varName
                          + " = new System.ComponentModel.ComponentResourceManager(typeof(" + className + "));" + nl;
            string newText = src.Substring(0, insertPos) + decl + src.Substring(insertPos);
            return (varName, newText, true);
        }

        /// <summary>safe-save gate for the resources-local insertion: the edited InitializeComponent is EXACTLY the
        /// original plus one added <c>ComponentResourceManager <paramref name="varName"/></c> local — every other
        /// statement is the same multiset, and the class field declarations are unchanged.</summary>
        internal static bool OnlyResourcesLocalAdded(string original, string edited, string varName)
        {
            var (origStmts, origCrm) = ClassifyStatements(original, varName);
            var (editStmts, editCrm) = ClassifyStatements(edited, varName);
            if (origCrm != 0) return false;                       // there was already a resources local → we shouldn't have inserted
            if (editCrm != 1) return false;                       // exactly one added
            if (!MultisetEqual(origStmts, editStmts)) return false; // nothing else changed
            return MultisetEqual(FieldNames(original), FieldNames(edited));
        }

        /// <summary>Non-resources-local statements (normalized) + count of ComponentResourceManager locals named
        /// <paramref name="varName"/> in InitializeComponent.</summary>
        private static (List<string> stmts, int crm) ClassifyStatements(string code, string varName)
        {
            var stmts = new List<string>();
            int crm = 0;
            var init = FindInitializeComponent(code);
            if (init?.Body != null)
            {
                foreach (var st in init.Body.Statements)
                {
                    if (st is LocalDeclarationStatementSyntax lds
                        && LastTypeSegment(lds.Declaration.Type.ToString()) == "ComponentResourceManager"
                        && lds.Declaration.Variables.Any(v => v.Identifier.Text == varName))
                    {
                        crm++;
                    }
                    else
                    {
                        stmts.Add(Normalize(st.ToString()));
                    }
                }
            }
            return (stmts, crm);
        }

        // ---- shared Roslyn helpers (kept local so the security-sensitive gate is self-contained) ----

        internal static MethodDeclarationSyntax? FindInitializeComponent(string code)
        {
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                var m = cls.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(x => x.Identifier.Text == "InitializeComponent");
                if (m != null) return m;
            }
            return null;
        }

        internal static string? ClassNameOf(string code)
        {
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
                if (cls.Members.OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.Text == "InitializeComponent"))
                    return cls.Identifier.Text;
            return null;
        }

        private static List<string> FieldNames(string code)
        {
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            var list = new List<string>();
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                if (!cls.Members.OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.Text == "InitializeComponent")) continue;
                foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var v in f.Declaration.Variables)
                        list.Add(v.Identifier.Text);
                break;
            }
            return list;
        }

        /// <summary>A name not used by any class field or ANY identifier anywhere in InitializeComponent — "resources",
        /// else "resourcesN". Scans the WHOLE method subtree (codex): a top-level-locals-only scan missed a name used by
        /// a nested-block local / loop / catch / lambda, which would emit a method-scope `resources` that collides
        /// (CS0136). Over-approximating with every IdentifierName token is safe — it only skips more candidate names.</summary>
        private static string UniqueName(string baseName, string src, MethodDeclarationSyntax init)
        {
            var used = new HashSet<string>(FieldNames(src), StringComparer.Ordinal);
            foreach (var id in init.DescendantNodes().OfType<IdentifierNameSyntax>())
                used.Add(id.Identifier.Text);
            foreach (var v in init.DescendantNodes().OfType<VariableDeclaratorSyntax>())
                used.Add(v.Identifier.Text);
            if (!used.Contains(baseName)) return baseName;
            for (int i = 1; ; i++)
            {
                string n = baseName + i;
                if (!used.Contains(n)) return n;
            }
        }

        private static string LastTypeSegment(string typeName)
        {
            int dot = typeName.LastIndexOf('.');
            return dot < 0 ? typeName : typeName.Substring(dot + 1);
        }

        private static string Normalize(string s) => new string(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

        private static bool MultisetEqual(List<string> a, List<string> b)
        {
            if (a.Count != b.Count) return false;
            var ca = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var i in a) ca[i] = ca.TryGetValue(i, out var c) ? c + 1 : 1;
            foreach (var i in b)
            {
                if (!ca.TryGetValue(i, out var c) || c == 0) return false;
                ca[i] = c - 1;
            }
            return ca.Values.All(v => v == 0);
        }

        private static int LineStart(string src, int pos) => src.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;

        private static string LeadingIndent(string text, int pos)
        {
            int lineStart = LineStart(text, pos);
            int i = lineStart;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            return text.Substring(lineStart, i - lineStart);
        }
    }

    /// <summary>Upsert one embedded (base64 bytearray) image entry into a WinForms <c>.resx</c>, creating the file
    /// from the standard skeleton when absent. Pure XML via <see cref="System.Xml.Linq"/> (values auto-escaped;
    /// DTD/entity resolution disabled). Never deserializes existing nodes — they are preserved as opaque XML.</summary>
    internal static class ResxImageWriter
    {
        /// <summary>Return the .resx text with a <c>&lt;data name=<paramref name="key"/>…&gt;</c> entry set to the
        /// embedded (bytearray.base64) image, or null when an EXISTING non-empty resx is malformed (refuse rather than
        /// clobber). Used for BackgroundImage/PictureBox.Image/Icon — a raw image byte array.</summary>
        public static string? Upsert(string? resxText, string key, string typeAttr, string base64) =>
            UpsertCore(resxText, key, () => new XElement("data",
                new XAttribute("name", key),
                new XAttribute("type", typeAttr),
                new XAttribute("mimetype", "application/x-microsoft.net.object.bytearray.base64"),
                new XElement("value", base64)));

        /// <summary>0.11.0 ImageList editor — upsert a BINARY-serialized object node (mimetype
        /// <c>application/x-microsoft.net.object.binary.base64</c>, no <c>type</c> attribute — VS's exact shape for an
        /// <c>ImageListStreamer</c>). <paramref name="base64"/> is produced by the net48 serializer; this side only
        /// embeds it as XML (never (de)serializes). Same verbatim-preservation + malformed-refuse contract as Upsert.</summary>
        public static string? UpsertBinaryObject(string? resxText, string key, string base64) =>
            UpsertCore(resxText, key, () => new XElement("data",
                new XAttribute("name", key),
                new XAttribute("mimetype", "application/x-microsoft.net.object.binary.base64"),
                new XElement("value", base64)));

        /// <summary>Load-or-skeleton the resx, remove any existing entry for <paramref name="key"/>, append the node
        /// built by <paramref name="makeNode"/>, and re-serialize. Returns null when an existing non-empty resx is
        /// malformed (refuse rather than clobber). Every non-target &lt;data&gt;/&lt;metadata&gt;/&lt;resheader&gt; node is
        /// preserved verbatim as opaque XML. (Known minor limitation, codex: document-level content OUTSIDE &lt;root&gt; —
        /// a top-level comment or processing instruction — is not re-emitted; WinForms/VS never write those in a .resx.)</summary>
        private static string? UpsertCore(string? resxText, string key, Func<XElement> makeNode)
        {
            XDocument doc;
            if (string.IsNullOrWhiteSpace(resxText))
            {
                doc = Skeleton();
            }
            else
            {
                try
                {
                    // Preserve ALL whitespace on load (default) so a resource whose <value> is whitespace-only
                    // (a spacer string) is NOT dropped, and so text-content newlines survive verbatim. Structural
                    // indentation is stripped separately below, then re-emitted uniformly by the XmlWriter — that
                    // keeps content faithful while still producing a cleanly-indented file.
                    var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
                    using var sr = new StringReader(resxText);
                    using var xr = XmlReader.Create(sr, settings);
                    doc = XDocument.Load(xr);
                }
                catch { return null; } // exists but unparseable → refuse (never destroy user data)
                if (doc.Root == null || doc.Root.Name.LocalName != "root") return null;
            }

            var root = doc.Root!;
            // remove any existing entry (embedded or file-ref) for this key, then append the fresh node.
            root.Elements("data").Where(d => (string?)d.Attribute("name") == key).ToList().ForEach(d => d.Remove());
            root.Add(makeNode());

            return Serialize(doc);
        }

        /// <summary>Serialize the resx uniformly indented WITHOUT mangling resource content: strip only the
        /// structural (inter-element) whitespace so the writer re-indents cleanly, and use
        /// <see cref="NewLineHandling.None"/> so newlines INSIDE a &lt;value&gt; (multi-line localized strings) are
        /// left verbatim rather than rewritten to CRLF. Whitespace-only &lt;value&gt; content is preserved (it has no
        /// element children, so it is never treated as structural).</summary>
        private static string Serialize(XDocument doc)
        {
            StripStructuralWhitespace(doc.Root!);
            var settings = new XmlWriterSettings
            {
                OmitXmlDeclaration = true, // we prepend an explicit utf-8 declaration below
                Indent = true,
                IndentChars = "  ",
                NewLineChars = "\r\n",
                NewLineHandling = NewLineHandling.None, // keep text-content newlines (value strings) verbatim
            };
            var sb = new System.Text.StringBuilder();
            using (var w = XmlWriter.Create(sb, settings)) doc.Root!.Save(w);
            return "<?xml version=\"1.0\" encoding=\"utf-8\"?>\r\n" + sb.ToString();
        }

        /// <summary>Remove whitespace-only text nodes that sit between/around ELEMENT children (indentation the
        /// writer will regenerate), but KEEP whitespace that is the sole content of a leaf element — i.e. a
        /// resource &lt;value&gt; that is legitimately all spaces. Recursive.</summary>
        private static void StripStructuralWhitespace(XElement el)
        {
            if (el.Elements().Any()) // has element children → its direct whitespace text nodes are formatting
            {
                foreach (var t in el.Nodes().OfType<XText>().Where(t => string.IsNullOrWhiteSpace(t.Value)).ToList())
                    t.Remove();
                foreach (var child in el.Elements()) StripStructuralWhitespace(child);
            }
        }

        /// <summary>The standard WinForms .resx skeleton: the four resheaders VS/MSBuild expect, no data yet.</summary>
        private static XDocument Skeleton()
        {
            XElement Header(string name, string value) =>
                new XElement("resheader", new XAttribute("name", name), new XElement("value", value));
            return new XDocument(new XElement("root",
                Header("resmimetype", "text/microsoft-resx"),
                Header("version", "2.0"),
                Header("reader", "System.Resources.ResXResourceReader, System.Windows.Forms"),
                Header("writer", "System.Resources.ResXResourceWriter, System.Windows.Forms")));
        }
    }
}
