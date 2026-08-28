namespace VisualStudioReference.Modern;

partial class S088InheritedMoveBaseForm
{
    private System.Windows.Forms.Button privateInheritedButton = null!;

    private void InitializeComponent()
    {
        this.privateInheritedButton = new System.Windows.Forms.Button();
        this.SuspendLayout();
        //
        // privateInheritedButton
        //
        this.privateInheritedButton.Location = new System.Drawing.Point(40, 40);
        this.privateInheritedButton.Name = "privateInheritedButton";
        this.privateInheritedButton.Size = new System.Drawing.Size(130, 30);
        this.privateInheritedButton.TabIndex = 0;
        this.privateInheritedButton.Text = "Private inherited";
        this.privateInheritedButton.UseVisualStyleBackColor = true;
        //
        // S088InheritedMoveBaseForm
        //
        this.AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        this.AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        this.ClientSize = new System.Drawing.Size(390, 170);
        this.Controls.Add(this.privateInheritedButton);
        this.Name = "S088InheritedMoveBaseForm";
        this.Text = "S088 inherited move base";
        this.ResumeLayout(false);
    }
}
