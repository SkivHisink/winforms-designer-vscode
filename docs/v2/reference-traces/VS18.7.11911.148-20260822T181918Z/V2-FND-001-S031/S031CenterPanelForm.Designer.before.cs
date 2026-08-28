namespace VisualStudioReference.Net48
{
    partial class S031CenterPanelForm
    {
        private System.Windows.Forms.Panel panel1;
        private System.Windows.Forms.Button button1;

        private void InitializeComponent()
        {
            this.panel1 = new System.Windows.Forms.Panel();
            this.button1 = new System.Windows.Forms.Button();
            this.panel1.SuspendLayout();
            this.SuspendLayout();
            //
            // panel1
            //
            this.panel1.Controls.Add(this.button1);
            this.panel1.Location = new System.Drawing.Point(20, 20);
            this.panel1.Name = "panel1";
            this.panel1.Padding = new System.Windows.Forms.Padding(10, 0, 20, 0);
            this.panel1.Size = new System.Drawing.Size(241, 120);
            this.panel1.TabIndex = 0;
            //
            // button1
            //
            this.button1.Location = new System.Drawing.Point(15, 40);
            this.button1.Name = "button1";
            this.button1.Size = new System.Drawing.Size(80, 24);
            this.button1.TabIndex = 0;
            this.button1.Text = "Center me";
            this.button1.UseVisualStyleBackColor = true;
            //
            // S031CenterPanelForm
            //
            this.AutoScaleDimensions = new System.Drawing.SizeF(6F, 13F);
            this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
            this.ClientSize = new System.Drawing.Size(320, 180);
            this.Controls.Add(this.panel1);
            this.Name = "S031CenterPanelForm";
            this.Text = "S031 center horizontally";
            this.panel1.ResumeLayout(false);
            this.ResumeLayout(false);
        }
    }
}
