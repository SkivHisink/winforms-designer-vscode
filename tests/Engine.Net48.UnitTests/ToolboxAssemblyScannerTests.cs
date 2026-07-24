using System;
using System.IO;
using System.Linq;
using WinFormsDesigner.Engine.Net48;
using Xunit;

namespace Engine.Net48.UnitTests
{
    public sealed class ToolboxAssemblyScannerTests
    {
        [Fact]
        public void ScanToolboxAssembly_FindsVendorControls_AndReleasesTheBrowsedFile()
        {
            var source = Path.Combine(AppContext.BaseDirectory, "FakeVendor.dll");
            Assert.True(File.Exists(source), "FakeVendor project output must be copied beside the test assembly.");

            var tempDir = Path.Combine(Path.GetTempPath(), "wfd-toolbox-scan-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(tempDir);
            var browsed = Path.Combine(tempDir, "FakeVendor.dll");
            File.Copy(source, browsed);
            try
            {
                AppDomain scanDomain = null;
                ToolboxScanResult result;
                try
                {
                    var setup = new AppDomainSetup
                    {
                        ApplicationBase = AppContext.BaseDirectory,
                    };
                    scanDomain = AppDomain.CreateDomain("WfdToolboxScanTest-" + Guid.NewGuid().ToString("N"), null, setup);
                    var scanner = (ToolboxAssemblyScanner)scanDomain.CreateInstanceAndUnwrap(
                        typeof(ToolboxAssemblyScanner).Assembly.FullName,
                        typeof(ToolboxAssemblyScanner).FullName);
                    result = scanner.Scan(browsed, new[] { AppContext.BaseDirectory });
                }
                finally
                {
                    if (scanDomain != null) AppDomain.Unload(scanDomain);
                }

                Assert.True(result.Items.Any(item =>
                    item.Name == "FancyButton"
                    && item.Namespace == "FakeVendor"
                    && item.AssemblyName == "FakeVendor"
                    && string.Equals(item.AssemblyPath, Path.GetFullPath(browsed), StringComparison.OrdinalIgnoreCase)),
                    "FakeVendor.FancyButton was not found: " + (result.Error ?? "<no scanner error>"));
                Assert.Equal(result.Items.Length, result.Items
                    .Select(item => item.Namespace + "." + item.Name)
                    .Distinct(StringComparer.Ordinal)
                    .Count());

                // The scan domain is short-lived. If either the scanner or the host default domain kept the browsed
                // DLL loaded after AppDomain.Unload, this delete fails on Windows and catches the rebuild regression.
                File.Delete(browsed);
                Assert.False(File.Exists(browsed));
            }
            finally
            {
                try { if (File.Exists(browsed)) File.Delete(browsed); } catch { }
                try { Directory.Delete(tempDir, recursive: true); } catch { }
            }
        }

        [Fact]
        public void ScanToolboxAssembly_MissingFile_ReturnsActionableError()
        {
            var missing = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"), "MissingControls.dll");
            var result = new ToolboxAssemblyScanner().Scan(missing, null);

            Assert.Empty(result.Items);
            Assert.Equal("MissingControls", result.AssemblyName);
            Assert.Equal("file not found", result.Error);
        }
    }
}
