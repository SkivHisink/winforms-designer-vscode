using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>Result of <see cref="DesignerImageListEditor.SetImages"/> — the WRITE side of the ImageList images
    /// editor. Carries BOTH the new .Designer.cs text (the ImageStream assignment + SetKeyName calls, with any in-code
    /// Images.Add removed) and the new sibling .resx text (the serialized ImageListStreamer binary node). Both null on
    /// rejection.</summary>
    public sealed class ImageListEditResult
    {
        public bool Ok { get; init; }
        public string? DesignerText { get; init; }
        public string? ResxText { get; init; }
        public string ResxKey { get; init; } = "";
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// The net9 WRITE side of the ImageList images editor: given the VS-format ImageStream base64 blob produced by the
    /// net48 serializer (the binary payload the net9 interpreter cannot itself create) plus the image keys, embed the
    /// blob into the form's sibling <c>.resx</c> as a binary node and rewrite the ImageList's init in InitializeComponent
    /// to the canonical serialized form:
    /// <code>
    ///   this.imageList1.ImageStream = ((System.Windows.Forms.ImageListStreamer)(resources.GetObject("imageList1.ImageStream")));
    ///   this.imageList1.Images.SetKeyName(0, "key0");
    ///   this.imageList1.Images.SetKeyName(1, "key1");
    /// </code>
    /// Any pre-existing in-code <c>Images.Add(...)</c> / <c>Images.SetKeyName(...)</c> for that ImageList is removed
    /// (it would double-populate or conflict). The engine NEVER writes files — it returns both texts; the host persists
    /// them atomically + undoably.
    ///
    /// SECURITY (fed a base64 blob + component id + keys from the UI): the component id must be a valid C# identifier;
    /// keys are emitted as ESCAPED string literals (<see cref="SyntaxFactory.Literal(string)"/>) and rejected if they
    /// carry a control character; the blob is embedded as opaque XML (never (de)serialized on this side); an
    /// existing-but-malformed .resx is REFUSED, never clobbered; the designer edit is confined to the ImageList's own
    /// Images/ImageStream statements (a focused multiset gate) + a parse check.
    /// </summary>
    public static class DesignerImageListEditor
    {
        private const int MaxImages = 256;
        private const int MaxBlobChars = 96 * 1024 * 1024; // base64 of a big-but-bounded ImageStream

        public static ImageListEditResult SetImages(string designerSrc, string componentId, string? resxText,
            string imageStreamBase64, string[]? keys)
        {
            if (!DesignerControlEditor.IsValidIdentifier(componentId))
                return Fail("invalid component id: " + componentId);
            if (string.IsNullOrEmpty(imageStreamBase64))
                return Fail("no ImageStream payload");
            if (imageStreamBase64.Length > MaxBlobChars)
                return Fail("ImageStream payload is too large");
            keys ??= Array.Empty<string>();
            if (keys.Length > MaxImages) return Fail("too many image keys");
            foreach (var k in keys)
                if (k != null && k.Any(char.IsControl))
                    return Fail("an image key contains a control character");

            // TRUST BOUNDARY (codex): the blob is meant to be produced ONLY by the net48 serializer (which builds a
            // real ImageList and self-round-trips before returning), and the host only ever passes THAT output here.
            // net9 cannot deserialize a BinaryFormatter stream to fully validate it, but it must not be a confused
            // deputy that embeds an ARBITRARY binary payload as an object resource (a later .NET Framework build would
            // deserialize it — a gadget sink). Two cheap guards keep the write honest: the payload must be valid base64,
            // and the decoded stream must carry the ImageListStreamer type marker — so the top-level type a build
            // deserializes is an ImageListStreamer (whose Deserialize just restores an image list), not some other type.
            byte[] decoded;
            try { decoded = Convert.FromBase64String(imageStreamBase64); }
            catch { return Fail("ImageStream payload is not valid base64"); }
            if (!ContainsAscii(decoded, "ImageListStreamer"))
                return Fail("ImageStream payload is not a serialized ImageListStreamer (must come from the engine serializer)");

            // 1. resx: embed the binary ImageStream node, preserving every other node verbatim (refuse a malformed resx).
            string key = componentId + ".ImageStream";
            string? newResx = ResxImageWriter.UpsertBinaryObject(resxText, key, imageStreamBase64);
            if (newResx == null) return Fail("the existing .resx is malformed and was not modified");

            // 2. designer edit.
            var init = DesignerImageEditor.FindInitializeComponent(designerSrc);
            if (init == null) return Fail("InitializeComponent not found");
            string? className = DesignerImageEditor.ClassNameOf(designerSrc);
            if (className == null) return Fail("could not find the form class");

            // 2a. drop any in-code Images.Add / Images.SetKeyName for this ImageList (they'd conflict with the stream).
            string removed = RemoveImageStatements(designerSrc, componentId);

            // 2b. ensure the ComponentResourceManager local (GetObject needs it).
            var (varName, afterLocal, insertedLocal) = DesignerImageEditor.EnsureResourcesLocal(removed, className);
            if (varName == null) return Fail("could not place the resources declaration");
            if (insertedLocal && !DesignerImageEditor.OnlyResourcesLocalAdded(removed, afterLocal, varName))
                return Fail("resources declaration edit changed more than intended");

            // 2c. set/insert the ImageStream assignment (EditProperty Replace/Insert; the ImageList's `new` line is a
            //     valid insert anchor, so this never fails for lack of an anchor).
            string rhs = "((System.Windows.Forms.ImageListStreamer)(" + varName + ".GetObject(\"" + key + "\")))";
            var edit = DesignerPropertyEditor.EditProperty(afterLocal, componentId, "ImageStream", rhs);
            if (edit.Mode == EditMode.Failed) return Fail(edit.Reason);

            // 2d. insert SetKeyName(i, "key") for each keyed image, right after the ImageStream assignment.
            string withKeys = InsertSetKeyNames(edit.NewText, componentId, keys);

            // 3. parse check + focused confinement gate: only this ImageList's Images/ImageStream statements (plus the
            //    optional resources local) may have changed.
            bool parseOk = !CSharpSyntaxTree.ParseText(withKeys).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            if (!parseOk) return Fail("edited designer text has syntax errors");
            if (!OnlyImageListStatementsChanged(designerSrc, withKeys, componentId, varName))
                return Fail("edit changed more than the ImageList's images");

            return new ImageListEditResult { Ok = true, DesignerText = withKeys, ResxText = newResx, ResxKey = key };
        }

        private static ImageListEditResult Fail(string reason) => new ImageListEditResult { Ok = false, Reason = reason };

        /// <summary>Remove every <c>this.&lt;comp&gt;.Images.Add(...)</c> / <c>.SetKeyName(...)</c> / <c>.Clear()</c>
        /// statement from InitializeComponent, whole-line (leading indent through the trailing newline), right-to-left
        /// so earlier spans stay valid.</summary>
        private static string RemoveImageStatements(string src, string comp)
        {
            var init = DesignerImageEditor.FindInitializeComponent(src);
            if (init?.Body == null) return src;
            var spans = new List<(int start, int end)>();
            foreach (var st in init.Body.Statements)
                if (st is ExpressionStatementSyntax es && IsImagesMutation(es.Expression, comp))
                    spans.Add(LineSpan(src, st.Span.Start, st.Span.End));
            // COALESCE identical/overlapping spans before splicing (codex): two image mutations on ONE physical line
            // yield the SAME whole-line span; applying it twice would splice with stale offsets and eat the next line.
            spans.Sort((a, b) => a.start.CompareTo(b.start));
            var merged = new List<(int start, int end)>();
            foreach (var sp in spans)
                if (merged.Count > 0 && sp.start <= merged[merged.Count - 1].end)
                    merged[merged.Count - 1] = (merged[merged.Count - 1].start, Math.Max(merged[merged.Count - 1].end, sp.end));
                else
                    merged.Add(sp);
            string cur = src;
            for (int i = merged.Count - 1; i >= 0; i--) // right-to-left so earlier offsets stay valid
                cur = cur.Substring(0, merged[i].start) + cur.Substring(merged[i].end);
            return cur;
        }

        /// <summary>Insert <c>this.&lt;comp&gt;.Images.SetKeyName(i, "key");</c> for each non-empty key, in order,
        /// immediately after the ImageStream assignment line.</summary>
        private static string InsertSetKeyNames(string src, string comp, string[] keys)
        {
            var init = DesignerImageEditor.FindInitializeComponent(src);
            if (init?.Body == null) return src;
            ExpressionStatementSyntax? anchor = null;
            foreach (var st in init.Body.Statements)
                if (st is ExpressionStatementSyntax es && es.Expression is AssignmentExpressionSyntax asg
                    && ChainEquals(asg.Left, comp, "ImageStream"))
                    anchor = es;
            if (anchor == null) return src; // no ImageStream statement (shouldn't happen — we just wrote it)

            string nl = src.Contains("\r\n") ? "\r\n" : "\n";
            string indent = LeadingIndent(src, anchor.Span.Start);
            var sb = new System.Text.StringBuilder();
            for (int i = 0; i < keys.Length; i++)
            {
                if (string.IsNullOrEmpty(keys[i])) continue; // a keyless image gets no SetKeyName (index-only access)
                string lit = SyntaxFactory.Literal(keys[i]).ToString(); // safely escaped C# string literal
                sb.Append(indent).Append("this.").Append(comp).Append(".Images.SetKeyName(")
                  .Append(i).Append(", ").Append(lit).Append(");").Append(nl);
            }
            if (sb.Length == 0) return src;
            int afterSemi = anchor.Span.End;
            int nlIdx = src.IndexOf('\n', afterSemi);
            int insertPos = nlIdx < 0 ? src.Length : nlIdx + 1;
            return src.Substring(0, insertPos) + sb + src.Substring(insertPos);
        }

        /// <summary>True for <c>[this.]comp.Images.Add(...)</c>, <c>.SetKeyName(...)</c> or <c>.Clear()</c>.</summary>
        private static bool IsImagesMutation(ExpressionSyntax expr, string comp)
        {
            if (expr is not InvocationExpressionSyntax inv) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma) return false;
            string method = ma.Name.Identifier.Text;
            if (method != "Add" && method != "AddRange" && method != "SetKeyName" && method != "Clear") return false;
            // the invocation target must be `[this.]comp.Images`
            return ma.Expression is MemberAccessExpressionSyntax imgs
                && imgs.Name.Identifier.Text == "Images"
                && ChainIsComponent(imgs.Expression, comp);
        }

        /// <summary>True when the chain is EXACTLY <c>this.comp.prop</c>. Requires the explicit `this.` (codex): a local
        /// variable shadowing the component field with the same name is valid C# that syntax alone can't distinguish, so
        /// this writer only manages the this-qualified field access VS always emits — an unqualified/shadow access then
        /// falls OUTSIDE the excluded set and trips the confinement gate (fail-closed) rather than editing the wrong object.</summary>
        private static bool ChainEquals(ExpressionSyntax expr, string comp, string prop)
        {
            var chain = Flatten(expr);
            return chain.Count == 3 && chain[0] == "this" && chain[1] == comp && chain[2] == prop;
        }

        /// <summary>True when the chain is EXACTLY <c>this.comp</c> (see <see cref="ChainEquals"/> re: the required `this.`).</summary>
        private static bool ChainIsComponent(ExpressionSyntax expr, string comp)
        {
            var chain = Flatten(expr);
            return chain.Count == 2 && chain[0] == "this" && chain[1] == comp;
        }

        /// <summary>Flatten a member-access / identifier / this chain to the identifier names, KEEPING a leading `this`.
        /// `this.a.b` → [this, a, b]; `a.b` → [a, b]; anything with a non-name link → empty (won't match).</summary>
        private static List<string> Flatten(ExpressionSyntax expr)
        {
            var parts = new List<string>();
            var cur = expr;
            while (true)
            {
                if (cur is MemberAccessExpressionSyntax ma) { parts.Add(ma.Name.Identifier.Text); cur = ma.Expression; }
                else if (cur is IdentifierNameSyntax id) { parts.Add(id.Identifier.Text); break; }
                else if (cur is ThisExpressionSyntax) { parts.Add("this"); break; }
                else { return new List<string>(); } // element access / cast / call → not a plain field chain
            }
            parts.Reverse();
            return parts;
        }

        /// <summary>Confinement gate: every InitializeComponent statement that is NOT one of this ImageList's
        /// Images/ImageStream statements — and not the (possibly inserted) <paramref name="resourcesVar"/> local —
        /// must be the SAME multiset before and after. Rejects an edit that reached beyond the ImageList's images.</summary>
        private static bool OnlyImageListStatementsChanged(string original, string edited, string comp, string resourcesVar)
        {
            var a = OtherStatements(original, comp, resourcesVar);
            var b = OtherStatements(edited, comp, resourcesVar);
            return MultisetEqual(a, b);
        }

        private static List<string> OtherStatements(string code, string comp, string resourcesVar)
        {
            var list = new List<string>();
            var init = DesignerImageEditor.FindInitializeComponent(code);
            if (init?.Body == null) return list;
            foreach (var st in init.Body.Statements)
            {
                // skip this ImageList's image mutations + its ImageStream assignment (the statements we manage).
                if (st is ExpressionStatementSyntax es)
                {
                    if (IsImagesMutation(es.Expression, comp)) continue;
                    if (es.Expression is AssignmentExpressionSyntax asg && ChainEquals(asg.Left, comp, "ImageStream")) continue;
                }
                // skip the ComponentResourceManager local named resourcesVar (EnsureResourcesLocal may have inserted it).
                if (st is LocalDeclarationStatementSyntax lds
                    && LastSegment(lds.Declaration.Type.ToString()) == "ComponentResourceManager"
                    && lds.Declaration.Variables.Any(v => v.Identifier.Text == resourcesVar))
                    continue;
                list.Add(Normalize(st.ToString()));
            }
            return list;
        }

        // ---- small text/collection helpers (kept local so this security-sensitive editor is self-contained) ----

        private static (int start, int end) LineSpan(string src, int start, int end)
        {
            int lineStart = src.LastIndexOf('\n', Math.Max(0, start - 1)) + 1;
            int nl = src.IndexOf('\n', end);
            int lineEnd = nl < 0 ? src.Length : nl + 1;
            return (lineStart, lineEnd);
        }

        private static string LeadingIndent(string text, int pos)
        {
            int lineStart = text.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;
            int i = lineStart;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            return text.Substring(lineStart, i - lineStart);
        }

        private static string LastSegment(string typeName)
        {
            int dot = typeName.LastIndexOf('.');
            return dot < 0 ? typeName : typeName.Substring(dot + 1);
        }

        private static string Normalize(string s) => new string(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

        /// <summary>True when the ASCII bytes of <paramref name="needle"/> occur in <paramref name="hay"/> (BinaryFormatter
        /// records type names as raw ASCII in the stream, so this confirms an expected top-level type is present).</summary>
        private static bool ContainsAscii(byte[] hay, string needle)
        {
            var n = System.Text.Encoding.ASCII.GetBytes(needle);
            if (n.Length == 0 || hay.Length < n.Length) return false;
            for (int i = 0; i <= hay.Length - n.Length; i++)
            {
                int j = 0;
                while (j < n.Length && hay[i + j] == n[j]) j++;
                if (j == n.Length) return true;
            }
            return false;
        }

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
    }
}
