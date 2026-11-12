using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// An ImageList as Visual Studio writes it: the ImageStream as a BinaryFormatter node of the .resx, then one
// Images.SetKeyName per image. The ImageListStreamer is read without BinaryFormatter (NRBF records, then Windows Forms'
// own constructor), only when its bytes are an image list in Visual Studio's layout, and nothing else from a binary
// node is served. A ColumnHeader, [DesignTimeVisible(false)], gets no tray chip but stays a listed component. Also the
// grid's Images editor, text box resizing and the per-click describe and geometry reuse.
public sealed class ImageListStreamTests
{
    private static readonly StaDispatcher Sta = new();

    // Two 4x4 images (red, blue), serialized by the .NET Framework's BinaryFormatter (System.Windows.Forms 4.0.0.0).
    private const string TwoImages = "AAEAAAD/////AQAAAAAAAAAMAgAAAFdTeXN0ZW0uV2luZG93cy5Gb3JtcywgVmVyc2lvbj00LjAuMC4wLCBDdWx0dXJlPW5ldXRyYWwsIFB1YmxpY0tleVRva2VuPWI3N2E1YzU2MTkzNGUwODkFAQAAACZTeXN0ZW0uV2luZG93cy5Gb3Jtcy5JbWFnZUxpc3RTdHJlYW1lcgEAAAAERGF0YQcCAgAAAAkDAAAADwMAAAD0AAAAAk1TRnQBSQFMAgEBAgEAAQUBAAEEAQABBAEAAQQBAAT/ASEBAAj/AUIBTQE2BwABNgMAASgDAAEQAwABCAMAAQEBAAEgBgABAv8AFQAC/wIAAv8CAAL/AgAD/wIAAv8CAAL/AgAC/wIAAf8iAAL/AgAC/wIAAv8CAAP/AgAC/wIAAv8CAAL/AgAB/yIAAv8CAAL/AgAC/wIAA/8CAAL/AgAC/wIAAv8CAAH/IgAC/wIAAv8CAAL/AgAD/wIAAv8CAAL/AgAC/wIAAf8gAAFCAU0BPgcAAT4DAAEoAwABEAMAAQgDAAEBAQABAQUAASAXAAP/IQAL";

    private static string Resx(string payload, string notesText = "From the resources") =>
        "<root><data name=\"imageList1.ImageStream\" mimetype=\"application/x-microsoft.net.object.binary.base64\"><value>"
        + payload + "</value></data><data name=\"notes.Text\" xml:space=\"preserve\"><value>" + notesText
        + "</value></data></root>";

    private const string Designer = @"
namespace Demo {
  partial class Form1 : System.Windows.Forms.Form {
    private System.ComponentModel.IContainer components;
    private System.Windows.Forms.ImageList imageList1;
    private System.Windows.Forms.ListView listView1;
    private System.Windows.Forms.ColumnHeader columnHeader1;
    private System.Windows.Forms.TextBox notes;
    private System.Windows.Forms.LinkLabel link1;
    private void InitializeComponent() {
      this.components = new System.ComponentModel.Container();
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(Form1));
      this.imageList1 = new System.Windows.Forms.ImageList(this.components);
      this.listView1 = new System.Windows.Forms.ListView();
      this.columnHeader1 = new System.Windows.Forms.ColumnHeader();
      this.notes = new System.Windows.Forms.TextBox();
      this.link1 = new System.Windows.Forms.LinkLabel();
      this.SuspendLayout();
      this.imageList1.ColorDepth = System.Windows.Forms.ColorDepth.Depth32Bit;
      this.imageList1.ImageStream = ((System.Windows.Forms.ImageListStreamer)(resources.GetObject(""imageList1.ImageStream"")));
      this.imageList1.TransparentColor = System.Drawing.Color.Transparent;
      this.imageList1.Images.SetKeyName(0, ""red"");
      this.imageList1.Images.SetKeyName(1, ""blue"");
      this.listView1.Columns.AddRange(new System.Windows.Forms.ColumnHeader[] { this.columnHeader1 });
      this.listView1.Location = new System.Drawing.Point(8, 8);
      this.listView1.Name = ""listView1"";
      this.listView1.Size = new System.Drawing.Size(200, 100);
      this.listView1.View = System.Windows.Forms.View.Details;
      this.columnHeader1.Text = ""Name"";
      this.ClientSize = new System.Drawing.Size(240, 180);
      this.notes.Location = new System.Drawing.Point(8, 112);
      this.notes.Multiline = true;
      this.notes.Name = ""notes"";
      this.notes.Size = new System.Drawing.Size(200, 20);
      this.notes.Text = resources.GetString(""notes.Text"");
      this.link1.AutoSize = true;
      this.link1.Location = new System.Drawing.Point(8, 150);
      this.link1.Name = ""link1"";
      this.link1.Text = ""Open the site"";
      this.Controls.Add(this.link1);
      this.Controls.Add(this.notes);
      this.Controls.Add(this.listView1);
      this.Name = ""Form1"";
      this.ResumeLayout(false);
    }
  }
}";

    // ------------------------------------------------------------------ payload helpers -----------------------------

    /// <summary>The streamer's Data bytes inside a BinaryFormatter payload (its array record ends right before them).</summary>
    private static (byte[] Payload, int DataAt, int DataLength) Locate(string base64)
    {
        var payload = Convert.FromBase64String(base64);
        int at = payload.AsSpan().IndexOf("MSFt"u8);
        Assert.True(at > 5);
        return (payload, at, BitConverter.ToInt32(payload, at - 5));
    }

    /// <summary>What Windows Forms decompresses the Data to: the bytes ImageList_Read gets.</summary>
    private static byte[] ImageListBytes()
    {
        var (payload, at, length) = Locate(TwoImages);
        var output = new System.Collections.Generic.List<byte>();
        for (int i = at + 4; i + 1 < at + length; i += 2) output.AddRange(Enumerable.Repeat(payload[i + 1], payload[i]));
        return output.ToArray();
    }

    /// <summary>The same serialized streamer with <paramref name="data"/> as its Data.</summary>
    private static string WithData(byte[] data)
    {
        var (payload, at, length) = Locate(TwoImages);
        var bytes = payload.Take(at - 5).Concat(BitConverter.GetBytes(data.Length)).Append(payload[at - 1])
            .Concat(data).Concat(payload.Skip(at + length)).ToArray();
        return Convert.ToBase64String(bytes);
    }

    private static byte[] Edited(Action<byte[]> edit)
    {
        var data = ImageListBytes();
        edit(data);
        return data;
    }

    private static void PutShort(byte[] data, int at, int value) => BitConverter.GetBytes((short)value).CopyTo(data, at);
    private static void PutInt(byte[] data, int at, int value) => BitConverter.GetBytes(value).CopyTo(data, at);

    // Layout of the two-image list: a 28-byte header, the 32-bit image bitmap at 28 (16x8), the 1-bit mask at 594.
    private const int ImageBitmap = 28, InfoHeader = 14, MaskBitmap = 594;

    // ------------------------------------------------------------------ the gate ------------------------------------

    [Fact]
    public void AnImageListStreamer_IsServed()
    {
        var r = SafeResxResolver.Parse(Resx(TwoImages));
        var streamer = Assert.IsType<ImageListStreamer>(r.Resolve("imageList1.ImageStream", isString: false));
        Assert.False(r.WasRefused("imageList1.ImageStream"));
        using var list = new ImageList { ImageStream = streamer };
        Assert.Equal(2, list.Images.Count);
        using var first = (System.Drawing.Bitmap)list.Images[0];
        Assert.Equal(System.Drawing.Color.Red.ToArgb(), first.GetPixel(1, 1).ToArgb());
    }

    [Fact]
    public void UncompressedData_InTheSameLayout_IsServed()
    {
        var r = SafeResxResolver.Parse(Resx(WithData(ImageListBytes())));
        var streamer = Assert.IsType<ImageListStreamer>(r.Resolve("imageList1.ImageStream", isString: false));
        using var list = new ImageList { ImageStream = streamer };
        Assert.Equal(2, list.Images.Count);
    }

    [Fact]
    public void AnotherSerializedType_IsStillRefused()
    {
        // Same records, root class renamed: not an ImageListStreamer, so never served.
        var bytes = Convert.FromBase64String(TwoImages);
        var text = Encoding.ASCII.GetBytes("ImageListStreamer");
        int at = bytes.AsSpan().IndexOf(text);
        Assert.True(at > 0);
        bytes[at + text.Length - 1] = (byte)'x';
        var r = SafeResxResolver.Parse(Resx(Convert.ToBase64String(bytes)));
        Assert.Null(r.Resolve("imageList1.ImageStream", isString: false));
        Assert.True(r.WasRefused("imageList1.ImageStream"));
    }

    [Fact]
    public void AStreamerUnderAnotherTypeAttribute_IsRefused()
    {
        string resx = Resx(TwoImages).Replace("<data name=\"imageList1.ImageStream\"",
            "<data name=\"imageList1.ImageStream\" type=\"System.Drawing.Bitmap, System.Drawing\"");
        var r = SafeResxResolver.Parse(resx);
        Assert.True(r.WasRefused("imageList1.ImageStream"));
    }

    [Fact]
    public void ATruncatedPayload_IsRefused()
    {
        var r = SafeResxResolver.Parse(Resx(TwoImages.Substring(0, 200)));
        Assert.True(r.WasRefused("imageList1.ImageStream"));
    }

    [Fact]
    public void CompressedData_IsMeasuredAsItExpands()
    {
        Assert.Equal(510, SafeResxResolver.ExpandedImageStreamLength(new byte[] { (byte)'M', (byte)'S', (byte)'F', (byte)'t', 255, 1, 255, 2 }));
        Assert.Equal(3, SafeResxResolver.ExpandedImageStreamLength(new byte[] { 1, 2, 3 }));
    }

    [Fact]
    public void TheVisualStudioLayout_Validates_CompressedOrNot()
    {
        var (payload, at, length) = Locate(TwoImages);
        Assert.True(SafeResxResolver.TryValidateImageListData(payload.Skip(at).Take(length).ToArray(), out var compressed), compressed);
        Assert.True(SafeResxResolver.TryValidateImageListData(ImageListBytes(), out var raw), raw);
        // without ILC_MASK there is no mask bitmap to read
        var noMask = Edited(d => PutShort(d, 18, 0x20)).Take(MaskBitmap).ToArray();
        Assert.True(SafeResxResolver.TryValidateImageListData(noMask, out var unmasked), unmasked);
    }

    public static TheoryData<string, string> Malformed => new()
    {
        { "version 0x600", "version 0x101" },
        { "image width 257", "outside 1..256" },
        { "image height 0", "outside 1..256" },
        { "more images than capacity", "capacity" },
        { "no images", "capacity" },
        { "capacity past the pixel budget", "capacity" },
        { "negative grow", "capacity" },
        { "bitmap narrower than four images", "layout" },
        { "bitmap taller than its capacity", "layout" },
        { "top-down bitmap", "layout" },
        { "run-length bitmap", "layout" },
        { "two planes", "layout" },
        { "a 2-bit bitmap", "layout" },
        { "a 32-bit mask", "layout" },
        { "a partial palette", "partial palette" },
        { "pixels cut short", "longer than its data" },
        { "no mask", "mask bitmap is missing" },
        { "header cut short", "shorter than an image list header" },
        { "not an image list", "version 0x101" },
    };

    [Theory]
    [MemberData(nameof(Malformed))]
    public void AnImageListOutsideTheLayout_IsRefusedBeforeWindowsFormsReadsIt(string change, string reason)
    {
        byte[] data = change switch
        {
            "version 0x600" => Edited(d => PutShort(d, 2, 0x600)),
            "image width 257" => Edited(d => PutShort(d, 10, 257)),
            "image height 0" => Edited(d => PutShort(d, 12, 0)),
            "more images than capacity" => Edited(d => PutShort(d, 4, 6)),
            "no images" => Edited(d => PutShort(d, 4, 0)),
            "capacity past the pixel budget" => Edited(d => { PutShort(d, 10, 256); PutShort(d, 12, 256); PutShort(d, 6, 300); }),
            "negative grow" => Edited(d => PutShort(d, 8, -1)),
            "bitmap narrower than four images" => Edited(d => PutInt(d, ImageBitmap + InfoHeader + 4, 12)),
            "bitmap taller than its capacity" => Edited(d => PutInt(d, ImageBitmap + InfoHeader + 8, 12)),
            "top-down bitmap" => Edited(d => PutInt(d, ImageBitmap + InfoHeader + 8, -8)),
            "run-length bitmap" => Edited(d => PutInt(d, ImageBitmap + InfoHeader + 16, 1)),
            "two planes" => Edited(d => PutShort(d, ImageBitmap + InfoHeader + 12, 2)),
            "a 2-bit bitmap" => Edited(d => PutShort(d, ImageBitmap + InfoHeader + 14, 2)),
            "a 32-bit mask" => Edited(d => PutShort(d, MaskBitmap + InfoHeader + 14, 32)),
            "a partial palette" => Edited(d => PutInt(d, MaskBitmap + InfoHeader + 32, 1)),
            "pixels cut short" => ImageListBytes().Take(ImageListBytes().Length - 1).ToArray(),
            "no mask" => ImageListBytes().Take(MaskBitmap).ToArray(),
            "header cut short" => ImageListBytes().Take(27).ToArray(),
            "not an image list" => Enumerable.Repeat((byte)0x41, 4096).ToArray(),
            _ => throw new ArgumentOutOfRangeException(nameof(change)),
        };
        Assert.False(SafeResxResolver.TryValidateImageListData(data, out var error));
        Assert.Contains(reason, error);
        // and the whole entry is refused, never handed to Windows Forms
        var r = SafeResxResolver.Parse(Resx(WithData(data)));
        Assert.Null(r.Resolve("imageList1.ImageStream", isString: false));
        Assert.True(r.WasRefused("imageList1.ImageStream"));
    }

    [Fact]
    public void ARunCutInHalf_IsRefused()
    {
        var (payload, at, length) = Locate(TwoImages);
        var data = payload.Skip(at).Take(length).Append((byte)7).ToArray();
        Assert.False(SafeResxResolver.TryValidateImageListData(data, out var error));
        Assert.Contains("ends inside a run", error);
    }

    // ------------------------------------------------------------------ SetKeyName ----------------------------------

    [Fact]
    public void SetKeyName_IsModeledAndReplayed()
    {
        var doc = DesignerIrBuilder.Build(Designer);
        Assert.Contains(doc!.Statements.OfType<IrSetImageKeyName>(), k => k.TargetName == "imageList1" && k.Index == 1 && k.Key == "blue");
        Assert.DoesNotContain(doc.UnrepresentableReasons, r => r.Contains("SetKeyName"));
        Assert.Null(IrValidate.Check(doc));

        var res = DesignerIrExecutor.Execute(doc, new Form(), new ResourceHost(SafeResxResolver.Parse(Resx(TwoImages))));
        Assert.True(res.Ok, res.FailureReason);
        var list = (ImageList)res.Instances["imageList1"];
        Assert.Equal(new[] { "red", "blue" }, list.Images.Keys.Cast<string>().ToArray());
    }

    [Fact]
    public void ANegativeImageIndex_FailsValidation()
    {
        var doc = DesignerIrBuilder.Build(Designer)!;
        doc.Statements.OfType<IrSetImageKeyName>().First().Index = -1;
        Assert.NotNull(IrValidate.Check(doc));
    }

    [Fact]
    public void AKeyForAnImageThatDidNotLoad_IsNamed_NotThrown()
    {
        const string withoutStream = @"
namespace Demo {
  partial class Form1 : System.Windows.Forms.Form {
    private System.ComponentModel.IContainer components;
    private System.Windows.Forms.ImageList imageList1;
    private void InitializeComponent() {
      this.components = new System.ComponentModel.Container();
      this.imageList1 = new System.Windows.Forms.ImageList(this.components);
      this.imageList1.Images.SetKeyName(0, ""red"");
    }
  }
}";
        var doc = DesignerIrBuilder.Build(withoutStream)!;
        Assert.Null(IrValidate.Check(doc));
        var res = DesignerIrExecutor.Execute(doc, new Form(), new ResourceHost(SafeResxResolver.Parse("<root/>")));
        Assert.False(res.Ok);
        Assert.Contains("imageList1.Images has no image #0", res.FailureReason);
    }

    [Fact]
    public void TheModernRender_ListsAKeyWhoseImageWasRefused_AndStillDrawsTheForm()
    {
        var layout = WithForm(f => Sta.Invoke(() => DesignerRenderer.RenderWithLayout(f)), TwoImages.Substring(0, 200));
        Assert.Contains(layout.Unrepresentable, u => u.Contains("SetKeyName(0, \"red\")") && u.Contains("has no image #0"));
        Assert.Contains(layout.Unrepresentable, u => u.Contains("SetKeyName(1, \"blue\")") && u.Contains("has no image #1"));
        Assert.Contains(layout.Controls, c => c.Id == "listView1");
        Assert.Equal(1, layout.UnrenderableResxCount);
    }

    // ------------------------------------------------------------------ render, tray, grid ---------------------------

    [Fact]
    public void TheModernRender_DrawsTheImageList_AndHidesColumnsFromTheTrayOnly()
    {
        var layout = WithForm(f => Sta.Invoke(() => DesignerRenderer.RenderWithLayout(f)));
        Assert.Empty(layout.Unrepresentable);
        Assert.Equal(0, layout.UnrenderableResxCount);
        Assert.Contains(layout.Tray, t => t.Id == "imageList1" && !t.TrayHidden);
        // no chip, as in Visual Studio's tray, but still a listed component (the Properties list selects it)
        Assert.Contains(layout.Tray, t => t.Id == "columnHeader1" && t.TrayHidden);
    }

    private static T WithForm<T>(Func<string, T> body, string payload = TwoImages)
    {
        string dir = Path.Combine(Path.GetTempPath(), "wfd-imagelist-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(dir);
        try
        {
            string designer = Path.Combine(dir, "Form1.Designer.cs");
            File.WriteAllText(designer, Designer);
            File.WriteAllText(Path.Combine(dir, "Form1.resx"), Resx(payload));
            return body(designer);
        }
        finally { try { Directory.Delete(dir, true); } catch { } }
    }

    [Fact]
    public void TheImages_AreListedWithAnEditor_AsInVisualStudio()
    {
        var images = WithForm(f => Sta.Invoke(() => DesignerRenderer.DescribeComponent(f, "imageList1")))!
            .Properties.Single(p => p.Name == "Images");
        Assert.True(images.IsCollection);
        Assert.Equal("System.Drawing.Image", images.CollectionItemType);
        Assert.False(images.ReadOnly);
    }

    // ------------------------------------------------------------------ text box geometry ---------------------------

    [Fact]
    public void AMultilineTextBox_CanBeResized()
    {
        // TextBox is always AutoSize; that fixes only a single-line box's height, so it never blocks the grips.
        var start = WithForm(f => Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(f, "notes")));
        Assert.True(start.CanResize, start.Reason);
        Assert.False(start.FixedHeight);
        // a single-line one only gets the left and right grips
        var single = WithForm(f => Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(f, "notes", null,
            File.ReadAllText(f).Replace("this.notes.Multiline = true;", ""))));
        Assert.True(single.CanResize, single.Reason);
        Assert.True(single.FixedHeight);
    }

    [Fact]
    public void ASingleLineTextBoxDockedTopOrBottom_HasNoGrips()
    {
        // Dock=Top/Bottom leaves only the height free, and a single-line box keeps its own height.
        foreach (string dock in new[] { "Top", "Bottom" })
        {
            string docked = Designer.Replace("this.notes.Multiline = true;", "this.notes.Dock = System.Windows.Forms.DockStyle." + dock + ";");
            var single = WithForm(f => Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(f, "notes", null, docked)));
            Assert.False(single.CanResize, dock);
            Assert.Contains("keeps its own height", single.Reason);
            // a multiline box docked the same way still sizes its height
            var multi = WithForm(f => Sta.Invoke(() => DesignerRenderer.BeginGeometryDrag(f, "notes", null,
                docked.Replace("this.notes.Name", "this.notes.Multiline = true;\n      this.notes.Name"))));
            Assert.True(multi.CanResize, multi.Reason);
        }
    }

    // ------------------------------------------------------------------ kept read-only graphs -----------------------

    // A graph is kept only for an assembly the host passes in (as it does whenever the project has a build); any
    // assembly will do for these framework-only forms.
    private static readonly string Build = typeof(FakeVendor.FancyButton).Assembly.Location;

    [Fact]
    public void ASelection_IsDescribedFromTheRenderedGraph_UntilTheSourceChanges()
    {
        WithForm(f => Sta.Invoke(() =>
        {
            string src = File.ReadAllText(f);
            DesignerRenderer.RenderWithLayout(f, Build, sourceText: src);
            Assert.Equal("Name", DesignerRenderer.DescribeComponent(f, "columnHeader1", Build, src)!
                .Properties.Single(p => p.Name == "Text").Value);
            string edited = src.Replace("this.columnHeader1.Text = \"Name\";", "this.columnHeader1.Text = \"Edited\";");
            Assert.Equal("Edited", DesignerRenderer.DescribeComponent(f, "columnHeader1", Build, edited)!
                .Properties.Single(p => p.Name == "Text").Value);
            return 0;
        }));
    }

    private static string[] Snapshot(ComponentInfo? info) =>
        info!.Properties.Select(p => p.Name + "=" + p.Value + (p.ReadOnly ? " (ro)" : "")).ToArray();

    [Fact]
    public void AGeometryStart_NeverChangesWhatTheNextDescribeReports()
    {
        // The geometry start creates the window handles; describing reads the graph as loaded. They never share one.
        WithForm(f => Sta.Invoke(() =>
        {
            string src = File.ReadAllText(f);
            var before = new[] { "link1", "notes", "listView1", "this" }.Select(id => Snapshot(DesignerRenderer.DescribeComponent(f, id, Build, src))).ToArray();
            foreach (string id in new[] { "link1", "notes", "listView1" })
                Assert.True(DesignerRenderer.BeginGeometryDrag(f, id, Build, src).Ok);
            var after = new[] { "link1", "notes", "listView1", "this" }.Select(id => Snapshot(DesignerRenderer.DescribeComponent(f, id, Build, src))).ToArray();
            for (int i = 0; i < before.Length; i++) Assert.Equal(before[i], after[i]);
            return 0;
        }));
    }

    [Fact]
    public void AChangedResx_IsSeenByTheNextDescribe_WithTheSameSource()
    {
        WithForm(f => Sta.Invoke(() =>
        {
            string src = File.ReadAllText(f);
            string Notes() => DesignerRenderer.DescribeComponent(f, "notes", Build, src)!.Properties.Single(p => p.Name == "Text").Value!;
            Assert.Equal("From the resources", Notes());
            string resx = Path.Combine(Path.GetDirectoryName(f)!, "Form1.resx");
            File.WriteAllText(resx, Resx(TwoImages, "Changed outside"));
            File.SetLastWriteTimeUtc(resx, DateTime.UtcNow.AddMinutes(1));
            Assert.Equal("Changed outside", Notes());
            return 0;
        }));
    }

    private sealed class ResourceHost : IIrHost
    {
        private readonly SafeResxResolver _resx;
        public ResourceHost(SafeResxResolver resx) => _resx = resx;
        public Type? ResolveType(string typeName) =>
            typeof(Control).Assembly.GetType(typeName, false) ?? typeof(System.Drawing.Color).Assembly.GetType(typeName, false)
            ?? typeof(System.ComponentModel.Container).Assembly.GetType(typeName, false) ?? Type.GetType(typeName, false);
        public object CreateComponent(Type type, string name, bool withContainer) => Activator.CreateInstance(type)!;
        public object? ResolveResource(string key, bool isString) => _resx.Resolve(key, isString);
        public bool WasResourceRefused(string key) => _resx.WasRefused(key);
        public bool HasResource(string key) => _resx.HasResource(key);
        public bool HasResourceSet => _resx.HasResourceSet;
        public bool ApplyResources(object target, string key, out string? error) => _resx.ApplyResources(target, key, out error);
    }
}
