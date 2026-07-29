using System;
using System.Windows.Forms;

namespace DevExpressDemo
{
    internal static class Program
    {
        /// <summary>Runs the same form the designer previews, so the preview can be compared against the real app.</summary>
        [STAThread]
        private static void Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new MainForm());
        }
    }
}
