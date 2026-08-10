using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Windows.Forms;
using WinFormsDesigner.Engine;
using Xunit;

namespace Engine.Net48.UnitTests
{
    /// <summary>The actual shared ApplyResources host/resolver/executor compiled for net48, mirroring the modern
    /// golden. This proves behavior parity, not merely that the neutral/parent/exact XML merge helper returns strings.</summary>
    public sealed class AssemblyIrLocalizationParityTests
    {
        [Fact]
        public void ApplyResources_MatchesModernGolden_ForCultureOverlayAndRtl()
        {
            const string source = @"
namespace Sample
{
  partial class LocalizableForm
  {
    private System.Windows.Forms.Button button1;
    private void InitializeComponent()
    {
      System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(LocalizableForm));
      this.button1 = new System.Windows.Forms.Button();
      resources.ApplyResources(this.button1, ""button1"");
      resources.ApplyResources(this, ""$this"");
      this.Controls.Add(this.button1);
    }
  }
}";
            const string neutral = @"<root>
  <data name='button1.Text' xml:space='preserve'><value>Neutral</value></data>
  <data name='button1.Size' type='System.Drawing.Size, System.Drawing'><value>120, 32</value></data>
  <data name='$this.RightToLeft' type='System.Windows.Forms.RightToLeft, System.Windows.Forms'><value>No</value></data>
  <data name='$this.AutoScaleDimensions' type='System.Drawing.SizeF, System.Drawing'><value>6, 13</value></data>
</root>";
            string imageBase64;
            using (var sourceImage = new Bitmap(2, 1))
            using (var imageStream = new MemoryStream())
            {
                sourceImage.SetPixel(0, 0, Color.Red);
                sourceImage.SetPixel(1, 0, Color.Blue);
                sourceImage.Save(imageStream, ImageFormat.Png);
                imageBase64 = System.Convert.ToBase64String(imageStream.ToArray());
            }
            string iconBase64;
            using (var sourceIcon = (Icon)SystemIcons.Application.Clone())
            using (var iconStream = new MemoryStream())
            {
                sourceIcon.Save(iconStream);
                iconBase64 = System.Convert.ToBase64String(iconStream.ToArray());
            }
            string culture = @"<root>
  <data name='button1.Text' xml:space='preserve'><value>Culture</value></data>
  <data name='button1.Image' type='System.Drawing.Bitmap, System.Drawing.Common' mimetype='application/x-microsoft.net.object.bytearray.base64'><value>" + imageBase64 + @"</value></data>
  <data name='$this.Icon' type='System.Drawing.Icon, System.Drawing.Common' mimetype='application/x-microsoft.net.object.bytearray.base64'><value>" + iconBase64 + @"</value></data>
  <data name='$this.RightToLeft' type='System.Windows.Forms.RightToLeft, System.Windows.Forms'><value>Yes</value></data>
  <data name='$this.RightToLeftLayout' type='System.Boolean, mscorlib'><value>True</value></data>
</root>";

            var document = DesignerIrBuilder.Build(source);
            using (var container = new DesignTimeContainer())
            using (var root = new Form())
            {
                var host = new AssemblyIrHost(
                    new[] { typeof(Form).Assembly, typeof(Component).Assembly },
                    container,
                    SafeResxResolver.Parse(neutral, culture));
                var result = DesignerIrExecutor.Execute(document, root, host);

                Assert.True(result.Ok, result.FailureReason);
                var button = Assert.IsType<Button>(result.Instances["button1"]);
                Assert.Equal("Culture", button.Text);
                Assert.Equal(new Size(120, 32), button.Size);
                Assert.NotNull(button.Image);
                Assert.Equal(new Size(2, 1), button.Image.Size);
                Assert.NotNull(root.Icon);
                Assert.True(root.Icon.Width > 0);
                Assert.Equal(RightToLeft.Yes, root.RightToLeft);
                Assert.True(root.RightToLeftLayout);
                Assert.Equal(new SizeF(6, 13), root.AutoScaleDimensions);
            }
        }
    }
}
