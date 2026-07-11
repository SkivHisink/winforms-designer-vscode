namespace SampleApp
{
    // Fixture for OVERFLOW items: a docked ToolStrip narrower than its buttons, so WinForms pushes the excess items into
    // the overflow dropdown (Placement==Overflow) and shows the overflow chevron. The engine emits those items bounds-less
    // under the chevron's ToolStripItemBounds (Overflow=true) so the canvas can reach them via a synthetic flyout. The
    // client width (120) is well below the six buttons' combined width, so several overflow on both engines; the e2e
    // asserts the ROBUST invariants (union of main+overflow ids == all six, >=1 overflow, chevron present, no Type-Here)
    // rather than an exact split, since text measurement could pick a slightly different boundary per runtime.
    partial class ToolStripOverflowForm
    {
        private void InitializeComponent()
        {
            this.toolStrip1 = new System.Windows.Forms.ToolStrip();
            this.btnOne = new System.Windows.Forms.ToolStripButton();
            this.btnTwo = new System.Windows.Forms.ToolStripButton();
            this.btnThree = new System.Windows.Forms.ToolStripButton();
            this.btnFour = new System.Windows.Forms.ToolStripButton();
            this.btnFive = new System.Windows.Forms.ToolStripButton();
            this.btnSix = new System.Windows.Forms.ToolStripButton();
            this.toolStrip1.SuspendLayout();
            this.SuspendLayout();
            this.toolStrip1.Items.AddRange(new System.Windows.Forms.ToolStripItem[] {
            this.btnOne,
            this.btnTwo,
            this.btnThree,
            this.btnFour,
            this.btnFive,
            this.btnSix});
            this.toolStrip1.Location = new System.Drawing.Point(0, 0);
            this.toolStrip1.Name = "toolStrip1";
            this.toolStrip1.Size = new System.Drawing.Size(120, 25);
            this.toolStrip1.TabIndex = 0;
            this.toolStrip1.Text = "toolStrip1";
            //
            // btnOne
            //
            this.btnOne.Name = "btnOne";
            this.btnOne.Size = new System.Drawing.Size(80, 22);
            this.btnOne.Text = "First Button";
            //
            // btnTwo
            //
            this.btnTwo.Name = "btnTwo";
            this.btnTwo.Size = new System.Drawing.Size(90, 22);
            this.btnTwo.Text = "Second Button";
            //
            // btnThree
            //
            this.btnThree.Name = "btnThree";
            this.btnThree.Size = new System.Drawing.Size(80, 22);
            this.btnThree.Text = "Third Button";
            //
            // btnFour
            //
            this.btnFour.Name = "btnFour";
            this.btnFour.Size = new System.Drawing.Size(90, 22);
            this.btnFour.Text = "Fourth Button";
            //
            // btnFive
            //
            this.btnFive.Name = "btnFive";
            this.btnFive.Size = new System.Drawing.Size(80, 22);
            this.btnFive.Text = "Fifth Button";
            //
            // btnSix
            //
            this.btnSix.Name = "btnSix";
            this.btnSix.Size = new System.Drawing.Size(80, 22);
            this.btnSix.Text = "Sixth Button";
            //
            // ToolStripOverflowForm
            //
            this.ClientSize = new System.Drawing.Size(120, 200);
            this.Controls.Add(this.toolStrip1);
            this.Name = "ToolStripOverflowForm";
            this.Text = "ToolStripOverflowForm";
            this.toolStrip1.ResumeLayout(false);
            this.toolStrip1.PerformLayout();
            this.ResumeLayout(false);
            this.PerformLayout();
        }

        private System.Windows.Forms.ToolStrip toolStrip1;
        private System.Windows.Forms.ToolStripButton btnOne;
        private System.Windows.Forms.ToolStripButton btnTwo;
        private System.Windows.Forms.ToolStripButton btnThree;
        private System.Windows.Forms.ToolStripButton btnFour;
        private System.Windows.Forms.ToolStripButton btnFive;
        private System.Windows.Forms.ToolStripButton btnSix;
    }
}
