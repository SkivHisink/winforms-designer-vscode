using System;
using System.Threading;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Compiles the source-edit path once in the background when a serving engine starts. Workers are isolated per
    /// project graph, so the worker that plans a form's first property edit is often young; without this its first
    /// edit pays the whole Roslyn JIT cost inside the user's gesture. Pure in-memory text work on a synthetic source:
    /// no file, project or assembly is touched, and any failure is ignored.
    /// </summary>
    internal static class EditPathWarmup
    {
        internal const string Source =
            "namespace Warmup\r\n{\r\n    partial class WarmupForm\r\n    {\r\n" +
            "        private System.Windows.Forms.Button button1;\r\n" +
            "        private void InitializeComponent()\r\n        {\r\n" +
            "            this.button1 = new System.Windows.Forms.Button();\r\n" +
            "            this.SuspendLayout();\r\n" +
            "            this.button1.Location = new System.Drawing.Point(12, 12);\r\n" +
            "            this.button1.Name = \"button1\";\r\n" +
            "            this.button1.Size = new System.Drawing.Size(75, 23);\r\n" +
            "            this.button1.Text = \"button1\";\r\n" +
            "            this.Controls.Add(this.button1);\r\n" +
            "            this.Name = \"WarmupForm\";\r\n" +
            "            this.ResumeLayout(false);\r\n        }\r\n    }\r\n}\r\n";

        internal static void Start()
        {
            var thread = new Thread(() =>
            {
                try { DesignerRenderer.ApplyPropertyEdit("WarmupForm.Designer.cs", "button1", "Text", "\"warm\"", Source); }
                catch { /* best effort: an edit later simply compiles on demand */ }
            })
            { IsBackground = true, Priority = ThreadPriority.BelowNormal, Name = "edit-path-warmup" };
            thread.Start();
        }
    }
}
