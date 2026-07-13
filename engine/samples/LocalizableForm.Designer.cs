namespace SampleApp
{
    // 0.10.0 trust-floor fixture — a [Localizable(true)] WinForms form. VS routes every localizable
    // property (Text / Location / Size / TabIndex / the form's own $this.* properties) through the
    // ComponentResourceManager's bulk `resources.ApplyResources(component, "name")` calls instead of
    // direct `this.x.Prop = ...` assignments; the real values live in the sibling LocalizableForm.resx.
    //
    // The net9 interpreter has NO handling for ApplyResources, so those statements are dropped as
    // unrepresentable and the controls render at their field defaults (a silent mis-render), and a
    // property edit would splice a direct assignment that diverges from the .resx (silent data loss).
    // The extension therefore treats this form as a READ-ONLY preview (isLocalizableDesigner → true).
    // Excluded from compilation (samples/**).
    partial class LocalizableForm
    {
        private System.ComponentModel.IContainer components = null;

        protected override void Dispose(bool disposing)
        {
            if (disposing && (components != null))
            {
                components.Dispose();
            }
            base.Dispose(disposing);
        }

        private void InitializeComponent()
        {
            System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof(LocalizableForm));
            this.button1 = new System.Windows.Forms.Button();
            this.label1 = new System.Windows.Forms.Label();
            this.SuspendLayout();
            //
            // button1
            //
            resources.ApplyResources(this.button1, "button1");
            this.button1.Name = "button1";
            //
            // label1
            //
            resources.ApplyResources(this.label1, "label1");
            this.label1.Name = "label1";
            //
            // LocalizableForm
            //
            resources.ApplyResources(this, "$this");
            this.Controls.Add(this.button1);
            this.Controls.Add(this.label1);
            this.Name = "LocalizableForm";
            this.ResumeLayout(false);
            this.PerformLayout();
        }

        private System.Windows.Forms.Button button1;
        private System.Windows.Forms.Label label1;
    }
}
