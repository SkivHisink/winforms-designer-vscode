namespace VisualStudioReference.Modern;

partial class S017MarqueeForm
{
    private System.Windows.Forms.Panel panel1 = null!;
    private System.Windows.Forms.Button enclosedButtonA = null!;
    private System.Windows.Forms.Button enclosedButtonB = null!;
    private System.Windows.Forms.Button partialButton = null!;
    private System.Windows.Forms.Button panelOutsideButton = null!;
    private System.Windows.Forms.Button formOutsideButtonA = null!;
    private System.Windows.Forms.Button formOutsideButtonB = null!;

    private void InitializeComponent()
    {
        panel1 = new System.Windows.Forms.Panel();
        enclosedButtonA = new System.Windows.Forms.Button();
        enclosedButtonB = new System.Windows.Forms.Button();
        partialButton = new System.Windows.Forms.Button();
        panelOutsideButton = new System.Windows.Forms.Button();
        formOutsideButtonA = new System.Windows.Forms.Button();
        formOutsideButtonB = new System.Windows.Forms.Button();
        panel1.SuspendLayout();
        SuspendLayout();
        //
        // panel1
        //
        panel1.BorderStyle = System.Windows.Forms.BorderStyle.FixedSingle;
        panel1.Controls.Add(panelOutsideButton);
        panel1.Controls.Add(partialButton);
        panel1.Controls.Add(enclosedButtonB);
        panel1.Controls.Add(enclosedButtonA);
        panel1.Location = new System.Drawing.Point(24, 24);
        panel1.Name = "panel1";
        panel1.Size = new System.Drawing.Size(250, 180);
        panel1.TabIndex = 0;
        //
        // enclosedButtonA
        //
        enclosedButtonA.Location = new System.Drawing.Point(20, 20);
        enclosedButtonA.Name = "enclosedButtonA";
        enclosedButtonA.Size = new System.Drawing.Size(70, 30);
        enclosedButtonA.TabIndex = 0;
        enclosedButtonA.Text = "Enclosed A";
        enclosedButtonA.UseVisualStyleBackColor = true;
        //
        // enclosedButtonB
        //
        enclosedButtonB.Location = new System.Drawing.Point(120, 20);
        enclosedButtonB.Name = "enclosedButtonB";
        enclosedButtonB.Size = new System.Drawing.Size(70, 30);
        enclosedButtonB.TabIndex = 1;
        enclosedButtonB.Text = "Enclosed B";
        enclosedButtonB.UseVisualStyleBackColor = true;
        //
        // partialButton
        //
        partialButton.Location = new System.Drawing.Point(190, 55);
        partialButton.Name = "partialButton";
        partialButton.Size = new System.Drawing.Size(55, 35);
        partialButton.TabIndex = 2;
        partialButton.Text = "Partial";
        partialButton.UseVisualStyleBackColor = true;
        //
        // panelOutsideButton
        //
        panelOutsideButton.Location = new System.Drawing.Point(20, 115);
        panelOutsideButton.Name = "panelOutsideButton";
        panelOutsideButton.Size = new System.Drawing.Size(100, 30);
        panelOutsideButton.TabIndex = 3;
        panelOutsideButton.Text = "Panel outside";
        panelOutsideButton.UseVisualStyleBackColor = true;
        //
        // formOutsideButtonA
        //
        formOutsideButtonA.Location = new System.Drawing.Point(310, 40);
        formOutsideButtonA.Name = "formOutsideButtonA";
        formOutsideButtonA.Size = new System.Drawing.Size(110, 30);
        formOutsideButtonA.TabIndex = 1;
        formOutsideButtonA.Text = "Form outside A";
        formOutsideButtonA.UseVisualStyleBackColor = true;
        //
        // formOutsideButtonB
        //
        formOutsideButtonB.Location = new System.Drawing.Point(310, 100);
        formOutsideButtonB.Name = "formOutsideButtonB";
        formOutsideButtonB.Size = new System.Drawing.Size(110, 30);
        formOutsideButtonB.TabIndex = 2;
        formOutsideButtonB.Text = "Form outside B";
        formOutsideButtonB.UseVisualStyleBackColor = true;
        //
        // S017MarqueeForm
        //
        AutoScaleDimensions = new System.Drawing.SizeF(7F, 15F);
        AutoScaleMode = System.Windows.Forms.AutoScaleMode.Font;
        ClientSize = new System.Drawing.Size(460, 240);
        Controls.Add(formOutsideButtonB);
        Controls.Add(formOutsideButtonA);
        Controls.Add(panel1);
        Name = "S017MarqueeForm";
        Text = "S017 marquee";
        panel1.ResumeLayout(false);
        ResumeLayout(false);
    }
}
