using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// The PNG of a capture at the integer scale a high-DPI display asks for, shared by both engines. The control tree
    /// is drawn once at its own size and every pixel becomes a scale×scale block of the same colour, so the image is
    /// the design surface exactly as it is laid out, at the scale's size. Scaling the live tree up instead
    /// (<c>Control.Scale</c>) drew a different surface: fonts keep their size under it, so text came out at half the
    /// size of everything else; a form's title bar and borders do not grow, so the client area sat offset from the
    /// hit-test map; and Windows limits a window to the screen's maximum tracking size, so a large form was clamped and
    /// laid out again, and scaling back left it smaller than its serialized size. A block of one pixel depends on that
    /// pixel alone, so a dirty patch scaled on its own is the same bytes as the same area of the scaled full frame.
    /// </summary>
    internal static class CapturePixels
    {
        public static byte[] EncodePng(Bitmap capture, int scale)
        {
            using (var stream = new MemoryStream())
            {
                if (scale <= 1)
                {
                    capture.Save(stream, ImageFormat.Png);
                    return stream.ToArray();
                }
                using (var scaled = Replicate(capture, scale))
                {
                    scaled.Save(stream, ImageFormat.Png);
                    return stream.ToArray();
                }
            }
        }

        /// <summary><paramref name="source"/> with every pixel repeated <paramref name="scale"/> times in each
        /// direction. 96 DPI is recorded, as for every capture, so the bytes do not depend on the display.</summary>
        public static Bitmap Replicate(Bitmap source, int scale)
        {
            int width = source.Width, height = source.Height;
            var scaled = new Bitmap(width * scale, height * scale, PixelFormat.Format32bppArgb);
            scaled.SetResolution(96, 96);
            BitmapData from = source.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.ReadOnly,
                PixelFormat.Format32bppArgb);
            try
            {
                BitmapData to = scaled.LockBits(new Rectangle(0, 0, scaled.Width, scaled.Height), ImageLockMode.WriteOnly,
                    PixelFormat.Format32bppArgb);
                try
                {
                    var row = new int[width];
                    var wide = new int[width * scale];
                    for (int y = 0; y < height; y++)
                    {
                        Marshal.Copy(from.Scan0 + y * from.Stride, row, 0, width);
                        for (int x = 0, k = 0; x < width; x++)
                            for (int s = 0; s < scale; s++)
                                wide[k++] = row[x];
                        for (int s = 0; s < scale; s++)
                            Marshal.Copy(wide, 0, to.Scan0 + (y * scale + s) * to.Stride, wide.Length);
                    }
                }
                finally { scaled.UnlockBits(to); }
            }
            finally { source.UnlockBits(from); }
            return scaled;
        }
    }
}
