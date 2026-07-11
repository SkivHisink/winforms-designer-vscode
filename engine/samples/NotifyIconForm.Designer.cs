namespace WinFormsDesigner.Samples
{
    // Fixture for a TRAY-COMPONENT component-reference (this.<trayComponent>.<prop> = this.<component>): a NotifyIcon
    // whose ContextMenuStrip points at a ContextMenuStrip sibling — the reference VS wires for a tray-icon right-click
    // menu. NotifyIcon/ContextMenuStrip are non-Control Components, so this exercises the reference dropdown on a TRAY
    // owner (the earlier ComponentRefForm/ContextMenuForm cover CONTROL owners only). No Icon is set on the NotifyIcon
    // (an Icon would force a BinaryFormatter .resx on .NET 9, like ErrorProvider) so the sample stays code-only; the
    // reference itself is a plain field assignment. The dropdown slice turns notifyIcon1.ContextMenuStrip into a
    // "(none)"+ContextMenuStrip-field-names <select> that pre-selects contextMenuStrip1.
    partial class NotifyIconForm
    {
        private System.ComponentModel.IContainer components;

        private void InitializeComponent()
        {
            this.components = new System.ComponentModel.Container();
            this.notifyIcon1 = new System.Windows.Forms.NotifyIcon(this.components);
            this.contextMenuStrip1 = new System.Windows.Forms.ContextMenuStrip(this.components);
            // errorProvider1.ContainerControl = this (the ROOT form) — a tray-component reference to the ROOT. The form
            // is assignable to ContainerControl, so describe offers the synthetic "(this)" token: both engines show a
            // "(none)"+"(this)" <select> that pre-selects "(this)". The net9 interpreter now assigns `= this` to the root
            // (was silently dropped) and net48 live-resolves "(this)" to the compiled root instance. No Icon is set
            // (default icon is not serialized), so no BinaryFormatter .resx on the NotifyIcon itself — note ErrorProvider
            // still forces a binary-resource serialize on .NET 9, so this form stays read-only-fallback on net9 (which is
            // exactly why promoting `= this` to representable cannot unblock a save → no data-loss surface).
            this.errorProvider1 = new System.Windows.Forms.ErrorProvider(this.components);
            this.button1 = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // notifyIcon1
            //
            this.notifyIcon1.ContextMenuStrip = this.contextMenuStrip1;
            this.notifyIcon1.Text = "Tray";
            //
            // errorProvider1
            //
            this.errorProvider1.ContainerControl = this;
            //
            // contextMenuStrip1
            //
            this.contextMenuStrip1.Name = "contextMenuStrip1";
            this.contextMenuStrip1.Size = new System.Drawing.Size(61, 4);
            //
            // button1
            //
            this.button1.Location = new System.Drawing.Point(40, 40);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(100, 30);
            this.button1.Text = "Show";
            //
            // NotifyIconForm
            //
            this.ClientSize = new System.Drawing.Size(300, 150);
            this.Controls.Add(this.button1);
            this.Name = "NotifyIconForm";
            this.Text = "NotifyIconForm";
            this.ResumeLayout(false);
        }

        private System.Windows.Forms.NotifyIcon notifyIcon1;
        private System.Windows.Forms.ContextMenuStrip contextMenuStrip1;
        private System.Windows.Forms.ErrorProvider errorProvider1;
        private System.Windows.Forms.Button button1;
    }
}
