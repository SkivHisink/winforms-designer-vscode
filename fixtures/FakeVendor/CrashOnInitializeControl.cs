using System;
using System.ComponentModel;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace FakeVendor
{
    /// <summary>
    /// Repository-owned hostile vendor fixture for V2-FND-001-S095. Constructing the ordinary control is safe, so a
    /// generic compiled form remains usable. Only activating its ComponentDesigner observes the marker and crashes
    /// the short-lived hosted-designer process from Initialize, exactly where a broken vendor designer fails in VS.
    /// </summary>
    [Designer(typeof(CrashOnInitializeDesigner))]
    public sealed class CrashOnInitializeControl : Button
    {
        public static string CrashMarkerPath(string assemblyPath)
        {
            using (var sha = SHA256.Create())
            using (var stream = File.OpenRead(assemblyPath))
            {
                var text = new StringBuilder(64);
                foreach (byte value in sha.ComputeHash(stream)) text.Append(value.ToString("x2"));
                return Path.Combine(Path.GetTempPath(), "wfd-s095-" + text + ".crash");
            }
        }
    }

    public sealed class CrashOnInitializeDesigner : ControlDesigner
    {
        public override void Initialize(IComponent component)
        {
            base.Initialize(component);
            string marker = CrashOnInitializeControl.CrashMarkerPath(
                typeof(CrashOnInitializeControl).Assembly.Location);
            if (!File.Exists(marker)) return;

            var fault = new InvalidOperationException(
                "V2-FND-001-S095 intentional FakeVendor ComponentDesigner.Initialize crash.");
            // FailFast makes the proof an actual worker-process loss instead of a caught test exception. The marker
            // exists only in the disposable Extension Host fixture output and the worker is on a private desktop.
            Environment.FailFast(fault.Message, fault);
        }
    }
}
