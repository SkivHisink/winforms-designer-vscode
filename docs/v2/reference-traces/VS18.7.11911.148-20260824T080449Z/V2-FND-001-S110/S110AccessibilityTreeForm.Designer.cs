namespace VisualStudioReference.Modern;

partial class S110AccessibilityTreeForm
{
    private System.ComponentModel.IContainer components = null!;
    private System.Windows.Forms.MenuStrip mainMenuStrip = null!;
    private System.Windows.Forms.ToolStripMenuItem fileMenuItem = null!;
    private System.Windows.Forms.Button submitButton = null!;
    private System.Windows.Forms.TextBox customerNameTextBox = null!;
    private System.Windows.Forms.Timer refreshTimer = null!;

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            components?.Dispose();
        }

        base.Dispose(disposing);
    }

    private void InitializeComponent()
    {
        this.components = new System.ComponentModel.Container();
        this.mainMenuStrip = new System.Windows.Forms.MenuStrip();
        this.fileMenuItem = new System.Windows.Forms.ToolStripMenuItem();
        this.submitButton = new System.Windows.Forms.Button();
        this.customerNameTextBox = new System.Windows.Forms.TextBox();
        this.refreshTimer = new System.Windows.Forms.Timer(this.components);
        this.mainMenuStrip.SuspendLayout();
        this.SuspendLayout();
        //
        // mainMenuStrip
        //
        this.mainMenuStrip.AccessibleName = "Main menu";
        this.mainMenuStrip.Items.AddRange(new System.Windows.Forms.ToolStripItem[] { this.fileMenuItem });
        this.mainMenuStrip.Location = new System.Drawing.Point(0, 0);
        this.mainMenuStrip.Name = "mainMenuStrip";
        this.mainMenuStrip.Size = new System.Drawing.Size(420, 24);
        this.mainMenuStrip.TabIndex = 0;
        //
        // fileMenuItem
        //
        this.fileMenuItem.AccessibleName = "File menu";
        this.fileMenuItem.Name = "fileMenuItem";
        this.fileMenuItem.Size = new System.Drawing.Size(37, 20);
        this.fileMenuItem.Text = "File";
        //
        // submitButton
        //
        this.submitButton.AccessibleName = "Submit button";
        this.submitButton.Location = new System.Drawing.Point(32, 92);
        this.submitButton.Name = "submitButton";
        this.submitButton.Size = new System.Drawing.Size(136, 36);
        this.submitButton.TabIndex = 2;
        this.submitButton.Text = "Submit";
        this.submitButton.UseVisualStyleBackColor = true;
        //
        // customerNameTextBox
        //
        this.customerNameTextBox.AccessibleName = "Customer name";
        this.customerNameTextBox.Location = new System.Drawing.Point(32, 48);
        this.customerNameTextBox.Name = "customerNameTextBox";
        this.customerNameTextBox.Size = new System.Drawing.Size(232, 23);
        this.customerNameTextBox.TabIndex = 1;
        this.customerNameTextBox.Text = "Ada Lovelace";
        //
        // refreshTimer
        //
        this.refreshTimer.Interval = 1500;
        //
        // S110AccessibilityTreeForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(420, 180);
        this.Controls.Add(this.submitButton);
        this.Controls.Add(this.customerNameTextBox);
        this.Controls.Add(this.mainMenuStrip);
        this.MainMenuStrip = this.mainMenuStrip;
        this.Name = "S110AccessibilityTreeForm";
        this.Text = "S110 accessibility tree";
        this.mainMenuStrip.ResumeLayout(false);
        this.mainMenuStrip.PerformLayout();
        this.ResumeLayout(false);
        this.PerformLayout();
    }
}
