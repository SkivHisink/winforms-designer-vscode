using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Resources;
using System.Windows.Forms;
using System.Xml.Linq;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>One image to embed in an ImageList — its decoded bytes (base64) and its key ("" = keyless).</summary>
    public sealed class ImageListImage
    {
        public string DataBase64 { get; set; } = "";
        public string Key { get; set; } = "";
    }

    /// <summary>The images + settings the host wants serialized into an ImageList's <c>ImageStream</c> resource. The
    /// host builds this from the files the user added in the ImageList images editor plus the ImageList's current
    /// ImageSize / ColorDepth / TransparentColor (so the serialized blob reflects what the user sees).</summary>
    public sealed class ImageListSpec
    {
        public ImageListImage[] Images { get; set; } = Array.Empty<ImageListImage>();
        public int Width { get; set; } = 16;
        public int Height { get; set; } = 16;
        /// <summary>ColorDepth enum member name (e.g. "Depth32Bit"); blank → Depth32Bit.</summary>
        public string ColorDepth { get; set; } = "";
        /// <summary>TransparentColor known-name (e.g. "Transparent", "Magenta"); blank → Transparent.</summary>
        public string TransparentColor { get; set; } = "";
    }

    /// <summary>Result of <see cref="ImageListSerializer.Serialize"/>: the VS-format base64 payload for the
    /// <c>imageList1.ImageStream</c> .resx node (mimetype <c>application/x-microsoft.net.object.binary.base64</c>),
    /// its key names in order, and a self-verified round-trip count. Ok=false with a reason on any rejection.</summary>
    public sealed class ImageStreamResult
    {
        public bool Ok { get; set; }
        /// <summary>Whitespace-free base64 of the serialized ImageListStreamer, ready to drop into a resx &lt;value&gt;.</summary>
        public string Base64 { get; set; } = "";
        /// <summary>The resx mimetype for the node (constant; surfaced so the writer stays in lockstep with the writer runtime).</summary>
        public string MimeType { get; set; } = "";
        /// <summary>Key names in image order (index → key); "" for a keyless image. The host emits SetKeyName(i, key).</summary>
        public string[] Keys { get; set; } = Array.Empty<string>();
        /// <summary>Images the blob deserializes back to (self round-trip check) — must equal the input count.</summary>
        public int Count { get; set; }
        public string Reason { get; set; } = "";
    }

    /// <summary>Result of <see cref="ImageListSerializer.Deserialize"/> — the current images (PNG bytes + keys) an
    /// ImageStream blob decodes to, plus the ImageList's size/depth/transparent, so the editor can show the existing
    /// images before the user edits. Ok=false with a reason on a malformed/foreign blob.</summary>
    public sealed class ImageListReadResult
    {
        public bool Ok { get; set; }
        public ImageListImage[] Images { get; set; } = Array.Empty<ImageListImage>();
        public int Width { get; set; }
        public int Height { get; set; }
        public string ColorDepth { get; set; } = "";
        public string TransparentColor { get; set; } = "";
        public string Reason { get; set; } = "";
    }

    /// <summary>
    /// The binary WRITE primitive for ImageList images — the one capability that genuinely requires the .NET
    /// Framework runtime (the net9 interpreter can't serialize an <see cref="ImageListStreamer"/>): build an
    /// ImageList from the given image bytes + settings, take its <c>ImageStream</c>, and serialize it EXACTLY as
    /// VS/WinForms does (via <see cref="ResXResourceWriter"/> → BinaryFormatter → base64). The host embeds the
    /// returned payload into the form's sibling .resx (net9 XML upsert) and emits the matching designer edit.
    ///
    /// SECURITY (fed image bytes + names from the UI): every image must actually DECODE as a GDI+ image within
    /// dimension/pixel/total-size bounds before it touches the native ImageList; the count is bounded; the color
    /// settings are parsed defensively (bad enum/name → the WinForms default). The output is base64 only. On any
    /// failure it returns Ok=false with a reason and writes nothing.
    /// </summary>
    public static class ImageListSerializer
    {
        private const int MaxImages = 256;                 // an ImageList with >256 images is pathological
        private const int MaxImageBytes = 16 * 1024 * 1024; // per-image DoS bound (matches DesignerImageEditor)
        private const int MaxDimension = 20000;
        private const long MaxPixels = 4096L * 4096L;       // per-image decoded-raster bound (pixel-bomb guard)
        private const long MaxTotalBytes = 64 * 1024 * 1024; // aggregate ENCODED-input bound
        // aggregate DECODED-raster bound (codex: MaxTotalBytes caps compressed input, but 256 highly-compressible
        // 4096² images each decode to ~64MB → ~16GB peak. Bound the decoded pixels we materialize+retain, so a
        // flat-colour pixel-bomb set can't exhaust memory before the first serialize).
        private const long MaxTotalPixels = 64L * 1024 * 1024; // 64M px ≈ 256MB @32bpp — generous for an ImageList
        private const int MaxBlobChars = 96 * 1024 * 1024;    // base64 of a big-but-bounded ImageStream (matches net9)

        public static ImageStreamResult Serialize(ImageListSpec spec)
        {
            if (spec == null) return Fail("no spec");
            if (spec.Images == null || spec.Images.Length == 0) return Fail("no images");
            if (spec.Images.Length > MaxImages) return Fail("too many images (" + spec.Images.Length + "; max " + MaxImages + ")");
            if (spec.Width <= 0 || spec.Height <= 0 || spec.Width > 256 || spec.Height > 256)
                return Fail("image size out of range (" + spec.Width + "x" + spec.Height + ")");

            // decode + validate every image up front (nothing touches the native ImageList until all pass).
            var bitmaps = new List<Bitmap>();
            long total = 0;
            long totalPixels = 0;
            try
            {
                foreach (var img in spec.Images)
                {
                    byte[] bytes;
                    try { bytes = Convert.FromBase64String(img?.DataBase64 ?? ""); }
                    catch { return CleanupFail(bitmaps, "an image payload was not valid base64"); }
                    if (bytes.Length == 0) return CleanupFail(bitmaps, "an image payload was empty");
                    if (bytes.Length > MaxImageBytes) return CleanupFail(bitmaps, "an image is too large");
                    total += bytes.Length;
                    if (total > MaxTotalBytes) return CleanupFail(bitmaps, "the images are too large in aggregate");
                    var (bmp, err) = DecodeBitmap(bytes);
                    if (bmp == null) return CleanupFail(bitmaps, err ?? "an image did not decode");
                    // aggregate decoded-raster budget — checked AFTER the per-image header probe already bounded each
                    // image, so a set of many large-but-compressible images can't balloon peak memory.
                    totalPixels += (long)bmp.Width * bmp.Height;
                    if (totalPixels > MaxTotalPixels) { bmp.Dispose(); return CleanupFail(bitmaps, "the images decode to too many pixels in aggregate"); }
                    bitmaps.Add(bmp);
                }

                using (var il = new ImageList())
                {
                    il.ImageSize = new Size(spec.Width, spec.Height);
                    il.ColorDepth = ParseColorDepth(spec.ColorDepth);
                    il.TransparentColor = ParseColor(spec.TransparentColor);
                    var keys = new string[bitmaps.Count];
                    for (int i = 0; i < bitmaps.Count; i++)
                    {
                        string key = spec.Images[i].Key ?? "";
                        keys[i] = key;
                        if (key.Length == 0) il.Images.Add(bitmaps[i]);
                        else il.Images.Add(key, bitmaps[i]);
                    }

                    string base64 = SerializeStream(il.ImageStream);
                    // self round-trip: the blob must deserialize back to the same image count (a corrupt/empty blob
                    // must NOT be written to the user's .resx).
                    int rtCount = RoundTripCount(base64);
                    if (rtCount != bitmaps.Count)
                        return Fail("serialized ImageStream did not round-trip (" + rtCount + " != " + bitmaps.Count + ")");

                    return new ImageStreamResult
                    {
                        Ok = true,
                        Base64 = base64,
                        MimeType = "application/x-microsoft.net.object.binary.base64",
                        Keys = keys,
                        Count = rtCount,
                    };
                }
            }
            catch (Exception ex) { return Fail("serialize failed: " + ex.GetType().Name + " " + ex.Message); }
            finally { foreach (var b in bitmaps) { try { b.Dispose(); } catch { } } }
        }

        private static ImageStreamResult Fail(string reason) => new ImageStreamResult { Ok = false, Reason = reason };
        private static ImageStreamResult CleanupFail(List<Bitmap> bmps, string reason)
        {
            foreach (var b in bmps) { try { b.Dispose(); } catch { } }
            bmps.Clear();
            return Fail(reason);
        }

        /// <summary>Decode bytes as a GDI+ bitmap within dimension/pixel bounds — header-only probe first so a pixel
        /// bomb is rejected before the full raster is materialized. Returns (bitmap, null) or (null, reason).</summary>
        private static (Bitmap?, string?) DecodeBitmap(byte[] bytes)
        {
            try
            {
                using (var ms = new MemoryStream(bytes, writable: false))
                {
                    int w, h;
                    using (var probe = Image.FromStream(ms, useEmbeddedColorManagement: false, validateImageData: false))
                    { w = probe.Width; h = probe.Height; }
                    if (w <= 0 || h <= 0 || w > MaxDimension || h > MaxDimension || (long)w * h > MaxPixels)
                        return (null, "image dimensions are out of range");
                    ms.Position = 0;
                    // materialize an owned copy (Image.FromStream keeps the stream alive; a copied Bitmap is self-contained).
                    using (var img = Image.FromStream(ms, useEmbeddedColorManagement: false, validateImageData: true))
                        return (new Bitmap(img), null);
                }
            }
            catch (Exception ex) { return (null, "not a valid image (" + ex.GetType().Name + ")"); }
        }

        /// <summary>Serialize an ImageListStreamer to VS-format base64 the same way ResXResourceWriter does, then
        /// pull the payload back out (whitespace-stripped) so it drops cleanly into a resx &lt;value&gt;.</summary>
        private static string SerializeStream(ImageListStreamer streamer)
        {
            var sw = new StringWriter();
            using (var w = new ResXResourceWriter(sw)) { w.AddResource("__il__", streamer); w.Generate(); }
            var doc = XDocument.Parse(sw.ToString());
            var node = doc.Root?.Elements("data").FirstOrDefault(d => (string?)d.Attribute("name") == "__il__");
            string raw = node?.Element("value")?.Value ?? "";
            return new string(raw.Where(c => !char.IsWhiteSpace(c)).ToArray());
        }

        /// <summary>Deserialize a base64 ImageStream payload back to an ImageList and count its images (self-check).</summary>
        private static int RoundTripCount(string base64)
        {
            try
            {
                // round-trip THROUGH the same resx node shape, so the check exercises the exact reader the compiler uses.
                string resx =
                    "<root><resheader name=\"resmimetype\"><value>text/microsoft-resx</value></resheader>" +
                    "<resheader name=\"version\"><value>2.0</value></resheader>" +
                    "<resheader name=\"reader\"><value>System.Resources.ResXResourceReader, System.Windows.Forms</value></resheader>" +
                    "<resheader name=\"writer\"><value>System.Resources.ResXResourceWriter, System.Windows.Forms</value></resheader>" +
                    "<data name=\"__il__\" mimetype=\"application/x-microsoft.net.object.binary.base64\"><value>" + base64 + "</value></data></root>";
                using (var sr = new StringReader(resx))
                using (var rr = new ResXResourceReader(sr))
                {
                    foreach (System.Collections.DictionaryEntry e in rr)
                    {
                        if ((string)e.Key == "__il__" && e.Value is ImageListStreamer streamer)
                        {
                            using (var il = new ImageList()) { il.ImageStream = streamer; return il.Images.Count; }
                        }
                    }
                }
            }
            catch { }
            return -1;
        }

        /// <summary>0.11.0 ImageList editor (READ side) — deserialize a VS-format ImageStream base64 blob back to the
        /// per-image PNG bytes + keys, so the editor can show the CURRENT images before the user edits them. Fully
        /// guarded: a malformed/foreign blob yields Ok=false, never throws. Keys come from the live ImageList's
        /// ImageCollection (the stream doesn't carry them; the designer restores keys via SetKeyName), so a caller that
        /// wants keys should also pass the current key list — here we return whatever the deserialized list exposes.</summary>
        public static ImageListReadResult Deserialize(string base64)
        {
            if (string.IsNullOrEmpty(base64)) return new ImageListReadResult { Ok = false, Reason = "no payload" };
            if (base64.Length > MaxBlobChars) return new ImageListReadResult { Ok = false, Reason = "payload too large" };
            try
            {
                string resx =
                    "<root><resheader name=\"resmimetype\"><value>text/microsoft-resx</value></resheader>" +
                    "<resheader name=\"version\"><value>2.0</value></resheader>" +
                    "<resheader name=\"reader\"><value>System.Resources.ResXResourceReader, System.Windows.Forms</value></resheader>" +
                    "<resheader name=\"writer\"><value>System.Resources.ResXResourceWriter, System.Windows.Forms</value></resheader>" +
                    "<data name=\"__il__\" mimetype=\"application/x-microsoft.net.object.binary.base64\"><value>" + base64 + "</value></data></root>";
                using (var sr = new StringReader(resx))
                using (var rr = new ResXResourceReader(sr))
                {
                    foreach (System.Collections.DictionaryEntry e in rr)
                    {
                        if ((string)e.Key != "__il__" || e.Value is not ImageListStreamer streamer) continue;
                        using (var il = new ImageList())
                        {
                            il.ImageStream = streamer;
                            var imgs = new List<ImageListImage>();
                            for (int i = 0; i < il.Images.Count && i < MaxImages; i++)
                            {
                                string k = i < il.Images.Keys.Count ? (il.Images.Keys[i] ?? "") : "";
                                using (var ms = new MemoryStream())
                                {
                                    il.Images[i].Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                                    imgs.Add(new ImageListImage { Key = k, DataBase64 = Convert.ToBase64String(ms.ToArray()) });
                                }
                            }
                            return new ImageListReadResult
                            {
                                Ok = true, Images = imgs.ToArray(),
                                Width = il.ImageSize.Width, Height = il.ImageSize.Height,
                                ColorDepth = il.ColorDepth.ToString(),
                                TransparentColor = il.TransparentColor.IsKnownColor ? il.TransparentColor.Name : "Transparent",
                            };
                        }
                    }
                }
                return new ImageListReadResult { Ok = false, Reason = "no ImageListStreamer in the payload" };
            }
            catch (Exception ex) { return new ImageListReadResult { Ok = false, Reason = "deserialize failed: " + ex.GetType().Name }; }
        }

        private static ColorDepth ParseColorDepth(string s) =>
            !string.IsNullOrWhiteSpace(s) && Enum.TryParse(s, out ColorDepth cd) && Enum.IsDefined(typeof(ColorDepth), cd)
                ? cd : ColorDepth.Depth32Bit;

        private static Color ParseColor(string s)
        {
            if (string.IsNullOrWhiteSpace(s)) return Color.Transparent;
            try { var c = Color.FromName(s.Trim()); if (c.IsKnownColor || c.A != 0 || c.Name == "Transparent") return c; } catch { }
            return Color.Transparent;
        }
    }
}
