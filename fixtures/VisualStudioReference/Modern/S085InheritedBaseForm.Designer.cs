namespace VisualStudioReference.Modern;

partial class S085InheritedBaseForm
{
    protected System.Windows.Forms.Button inheritedButton = null!;

    private void InitializeComponent()
    {
        this.inheritedButton = new System.Windows.Forms.Button();
        this.SuspendLayout();
        //
        // inheritedButton
        //
        this.inheritedButton.Location = new System.Drawing.Point(38, 44);
        this.inheritedButton.Name = "inheritedButton";
        this.inheritedButton.Size = new System.Drawing.Size(150, 38);
        this.inheritedButton.TabIndex = 0;
        this.inheritedButton.Text = "Base inherited";
        this.inheritedButton.UseVisualStyleBackColor = true;
        //
        // S085InheritedBaseForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(340, 180);
        this.Controls.Add(this.inheritedButton);
        this.Name = "S085InheritedBaseForm";
        this.Text = "S085 inherited base";
        this.ResumeLayout(false);
    }
}
