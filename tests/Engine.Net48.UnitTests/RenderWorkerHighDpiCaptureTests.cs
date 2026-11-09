using System;
using System.Collections;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Xunit;

namespace Engine.Net48.UnitTests
{
    /// <summary>A 2x capture of a compiled .NET Framework root is the 1x design surface with every pixel repeated: text
    /// at its size, a form's frame where the hit-test map puts it, and the cached instance left as it was laid out.</summary>
    public sealed class RenderWorkerHighDpiCaptureTests
    {
        [Theory]
        [InlineData(typeof(HighDpiFrameForm))]
        [InlineData(typeof(HighDpiSurface))]
        public void TwoXCapture_IsTheOneXSurfaceWithEveryPixelRepeated(Type root)
        {
            object worker = CreateWorker();
            try
            {
                object one = Render(worker, root, 1);
                object two = Render(worker, root, 2);

                Assert.Equal(Layout(one), Layout(two));
                AssertRepeated(Pixels(one), Pixels(two), 2);
                if (root == typeof(HighDpiFrameForm))
                {
                    object marker = Controls(two).Single(c => (string)Get(c, "Id") == "marker");
                    int x = (int)Get(marker, "X") + 3, y = (int)Get(marker, "Y") + 3;
                    Assert.True(x > 3 && y > 3, "expected a framed root with chrome");
                    var (pixels, width, _) = Pixels(two);
                    Color pixel = Color.FromArgb(pixels[(y * 2 + 1) * width + x * 2 + 1]);
                    Assert.True(pixel.R > 200 && pixel.G < 60 && pixel.B < 60, "(" + x + "," + y + ") is " + pixel + ", not the red marker");
                }
            }
            finally
            {
                DiscardLive(worker, root);
            }
        }

        // The compiled instance is cached across renders: a 2x capture that rescaled it left a form the screen fits only
        // at 1x clamped by Windows and laid out again, so every later render showed it smaller than serialized.
        [Fact]
        public void TwoXCapture_OfAFormTheScreenFitsOnlyAtOneX_LeavesTheCachedInstanceAsSerialized()
        {
            object worker = CreateWorker();
            try
            {
                object before = Render(worker, typeof(HighDpiLargeForm), 1);
                object two = Render(worker, typeof(HighDpiLargeForm), 2);
                object after = Render(worker, typeof(HighDpiLargeForm), 1);

                Size serialized = HighDpiLargeForm.Serialized;
                Assert.Equal(serialized, new Size((int)Get(before, "ClientWidth"), (int)Get(before, "ClientHeight")));
                Assert.Equal(Layout(before), Layout(two));
                Assert.Equal(Layout(before), Layout(after));
                AssertRepeated(Pixels(before), Pixels(two), 2);
                Assert.Equal((byte[])Get(before, "Png"), (byte[])Get(after, "Png"));
            }
            finally
            {
                DiscardLive(worker, typeof(HighDpiLargeForm));
            }
        }

        private static object Render(object worker, Type root, int scale) =>
            worker.GetType().GetMethod("RenderWithLayout")!.Invoke(worker,
                new object[] { root.Assembly.Location, root.FullName!, 0, 0, scale })!;

        private static string Layout(object result) =>
            string.Join(";", Controls(result).Select(c => Get(c, "Id") + ":" + Get(c, "X") + "," + Get(c, "Y") + ","
                + Get(c, "Width") + "," + Get(c, "Height")))
            + "|" + Get(result, "Width") + "x" + Get(result, "Height") + "|" + Get(result, "ClientWidth") + "x" + Get(result, "ClientHeight");

        private static (int[] Pixels, int Width, int Height) Pixels(object result)
        {
            using (var stream = new MemoryStream((byte[])Get(result, "Png")))
            using (var image = new Bitmap(stream))
            {
                BitmapData data = image.LockBits(new Rectangle(0, 0, image.Width, image.Height), ImageLockMode.ReadOnly,
                    PixelFormat.Format32bppArgb);
                try
                {
                    var pixels = new int[image.Width * image.Height];
                    for (int y = 0; y < image.Height; y++)
                        Marshal.Copy(data.Scan0 + y * data.Stride, pixels, y * image.Width, image.Width);
                    return (pixels, image.Width, image.Height);
                }
                finally { image.UnlockBits(data); }
            }
        }

        private static void AssertRepeated((int[] Pixels, int Width, int Height) one, (int[] Pixels, int Width, int Height) scaled, int scale)
        {
            Assert.Equal((one.Width * scale, one.Height * scale), (scaled.Width, scaled.Height));
            for (int y = 0; y < scaled.Height; y++)
                for (int x = 0; x < scaled.Width; x++)
                    if (scaled.Pixels[y * scaled.Width + x] != one.Pixels[y / scale * one.Width + x / scale])
                        Assert.Fail("2x pixel (" + x + "," + y + ") is not the 1x pixel (" + x / scale + "," + y / scale + ")");
        }

        private static object CreateWorker()
        {
            Type workerType = Net48EngineAssembly().GetType("WinFormsDesigner.Engine.Net48.RenderWorker", throwOnError: true)!;
            return Activator.CreateInstance(workerType)!;
        }

        private static void DiscardLive(object worker, Type root) =>
            worker.GetType().GetMethod("DiscardLive")!.Invoke(worker, new object[] { root.Assembly.Location, root.FullName!, "" });

        private static object[] Controls(object result) =>
            ((IEnumerable)Get(result, "Controls")).Cast<object>().ToArray();

        private static object Get(object instance, string propertyName) =>
            instance.GetType().GetProperty(propertyName)!.GetValue(instance)!;

        private static Assembly Net48EngineAssembly()
        {
            string config = typeof(RenderWorkerHighDpiCaptureTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            string path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..",
                "engine-net48", "bin", config, "net48", "WinFormsDesigner.Engine.Net48.exe"));
            Assert.True(File.Exists(path), "Expected built net48 engine at " + path);
            return Assembly.LoadFrom(path);
        }
    }

    public sealed class HighDpiFrameForm : Form
    {
        private readonly Panel marker;
        private readonly Label label1;

        public HighDpiFrameForm()
        {
            marker = new Panel { Name = "marker", BackColor = Color.Red, Location = new Point(20, 20), Size = new Size(40, 40) };
            label1 = new Label { Name = "label1", AutoSize = true, Location = new Point(80, 20), Text = "Text at its own size" };
            Controls.Add(marker);
            Controls.Add(label1);
            ClientSize = new Size(300, 120);
        }
    }

    public sealed class HighDpiSurface : UserControl
    {
        private readonly Label label1;
        private readonly Button button1;

        public HighDpiSurface()
        {
            label1 = new Label { Name = "label1", AutoSize = true, Location = new Point(10, 10), Text = "Text at its own size" };
            button1 = new Button { Name = "button1", Location = new Point(150, 60), Size = new Size(90, 30), Text = "Button" };
            Controls.Add(label1);
            Controls.Add(button1);
            Size = new Size(300, 120);
        }
    }

    public sealed class HighDpiLargeForm : Form
    {
        private readonly Label label1;

        public static Size Serialized => new Size(SystemInformation.MaxWindowTrackSize.Width * 3 / 5,
            SystemInformation.MaxWindowTrackSize.Height * 3 / 5);

        public HighDpiLargeForm()
        {
            label1 = new Label { Name = "label1", AutoSize = true, Location = new Point(10, 10), Text = "Text at its own size" };
            Controls.Add(label1);
            ClientSize = Serialized;
        }
    }
}
