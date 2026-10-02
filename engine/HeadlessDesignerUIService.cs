using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Text.RegularExpressions;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// The design surface's <see cref="IUIService"/>. Without one, ControlDesigner and the component tray fall back to
    /// a modal MessageBox when a control throws on the surface ("…has thrown an unhandled exception in the designer and
    /// has been disabled"): a window on the user's desktop from a process that never shows UI, which also blocks the
    /// engine's STA thread until somebody clicks it. This service never shows anything. Errors are recorded and
    /// reported as unrepresentable statements of the form, every question is answered with Cancel, and no editor or
    /// tool window opens.
    /// </summary>
    internal sealed class HeadlessDesignerUIService : IUIService
    {
        private const int MaxErrors = 32;
        private const int MaxErrorChars = 400;

        private readonly List<string> _errors = new();

        public IReadOnlyList<string> Errors => _errors;

        public IDictionary Styles { get; } = new Hashtable
        {
            ["DialogFont"] = Control.DefaultFont,
            ["HighlightColor"] = SystemColors.Highlight,
        };

        public bool CanShowComponentEditor(object component) => false;

        // No dialog is ever shown, so there is no owner to offer.
        public IWin32Window GetDialogOwnerWindow() => null!;

        public void SetUIDirty() { }

        public bool ShowComponentEditor(object component, IWin32Window parent) => false;

        public DialogResult ShowDialog(Form form) => DialogResult.Cancel;

        public void ShowError(string message) => Record(message);

        public void ShowError(Exception ex) => Record(ex?.Message);

        public void ShowError(Exception ex, string message) => Record(string.IsNullOrEmpty(message) ? ex?.Message : message);

        public void ShowMessage(string message) { }

        public void ShowMessage(string message, string caption) { }

        public DialogResult ShowMessage(string message, string caption, MessageBoxButtons buttons) => DialogResult.Cancel;

        public bool ShowToolWindow(Guid toolWindow) => false;

        private void Record(string? message)
        {
            if (_errors.Count >= MaxErrors) return;
            // The designer's text carries the full stack trace; one bounded line is what the warning banner needs.
            string text = Regex.Replace(message ?? "(no message)", @"\s+", " ").Trim();
            if (text.Length > MaxErrorChars) text = text.Substring(0, MaxErrorChars) + "…";
            _errors.Add(text);
        }
    }
}
