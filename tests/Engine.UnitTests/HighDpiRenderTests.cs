using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// Proves the high-DPI capture path (Control.Scale + DrawToBitmap) renders GENUINE detail at 2x — text/edges drawn at the
// higher resolution — rather than upscaling the 1x frame. If it were a plain upscale, a 2x native render would be
// (nearly) identical to a bicubic upscale of the 1x render; a crisp render differs materially. This gates the DPI-aware
// render feature: without it the 4K canvas is blurry.
public sealed class HighDpiRenderTests
{
    private static string Sample(string name)
    {
        for (var d = new DirectoryInfo(AppContext.BaseDirectory); d != null; d = d.Parent)
        {
            var p = Path.Combine(d.FullName, "engine", "samples", name);
            if (File.Exists(p)) return p;
        }
        throw new FileNotFoundException("sample not found: " + name);
    }

    [Fact]
    public void ScaledRender_IsCrisp_NotAPlainUpscale()
    {
        var path = Sample("SampleForm.Designer.cs");
        var r1 = DesignerRenderer.RenderWithLayout(path);
        var r2 = DesignerRenderer.RenderWithLayout(path, renderScale: 2);

        using var img1 = new Bitmap(new MemoryStream(r1.Png));
        using var img2 = new Bitmap(new MemoryStream(r2.Png));

        // The 2x render is exactly twice the logical frame in pixels; the reported logical Width/Height are unchanged.
        Assert.Equal(r1.Width * 2, img2.Width);
        Assert.Equal(r1.Height * 2, img2.Height);
        Assert.Equal(r1.Width, r2.Width);   // logical dims unchanged — overlays/hit-test stay logical
        Assert.Equal(img1.Width, r1.Width);

        // Bicubic-upscale the 1x render to the 2x size; a genuinely crisp native render must differ from it.
        using var up = new Bitmap(img2.Width, img2.Height, PixelFormat.Format32bppArgb);
        using (var g = Graphics.FromImage(up))
        {
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.DrawImage(img1, 0, 0, up.Width, up.Height);
        }

        long diff = 0, n = 0;
        for (int y = 0; y < img2.Height; y += 3)
            for (int x = 0; x < img2.Width; x += 3)
            {
                var a = img2.GetPixel(x, y);
                var b = up.GetPixel(x, y);
                diff += Math.Abs(a.R - b.R) + Math.Abs(a.G - b.G) + Math.Abs(a.B - b.B);
                n++;
            }
        double avg = (double)diff / Math.Max(1, n);
        Assert.True(avg > 2.0, "2x render looks like a plain upscale (avg per-channel diff " + avg.ToString("F2") + ") — Control.Scale did not add real detail");
    }
}
