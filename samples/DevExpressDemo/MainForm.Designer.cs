namespace DevExpressDemo
{
    partial class MainForm
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
            this.xtraTabControl1 = new DevExpress.XtraTab.XtraTabControl();
            this.tabGeneral = new DevExpress.XtraTab.XtraTabPage();
            this.simpleButtonSave = new DevExpress.XtraEditors.SimpleButton();
            this.checkEditActive = new DevExpress.XtraEditors.CheckEdit();
            this.comboBoxEditRole = new DevExpress.XtraEditors.ComboBoxEdit();
            this.textEditName = new DevExpress.XtraEditors.TextEdit();
            this.labelControlRole = new DevExpress.XtraEditors.LabelControl();
            this.labelControlName = new DevExpress.XtraEditors.LabelControl();
            this.tabDetails = new DevExpress.XtraTab.XtraTabPage();
            this.memoEditNotes = new DevExpress.XtraEditors.MemoEdit();
            this.buttonEditFile = new DevExpress.XtraEditors.ButtonEdit();
            this.labelControlFile = new DevExpress.XtraEditors.LabelControl();
            this.simpleButtonClose = new DevExpress.XtraEditors.SimpleButton();
            this.frameworkButton = new System.Windows.Forms.Button();
            ((System.ComponentModel.ISupportInitialize)(this.xtraTabControl1)).BeginInit();
            this.xtraTabControl1.SuspendLayout();
            this.tabGeneral.SuspendLayout();
            ((System.ComponentModel.ISupportInitialize)(this.checkEditActive.Properties)).BeginInit();
            ((System.ComponentModel.ISupportInitialize)(this.comboBoxEditRole.Properties)).BeginInit();
            ((System.ComponentModel.ISupportInitialize)(this.textEditName.Properties)).BeginInit();
            this.tabDetails.SuspendLayout();
            ((System.ComponentModel.ISupportInitialize)(this.memoEditNotes.Properties)).BeginInit();
            ((System.ComponentModel.ISupportInitialize)(this.buttonEditFile.Properties)).BeginInit();
            this.SuspendLayout();
            //
            // xtraTabControl1
            //
            this.xtraTabControl1.Anchor = ((System.Windows.Forms.AnchorStyles)((((System.Windows.Forms.AnchorStyles.Top | System.Windows.Forms.AnchorStyles.Bottom)
            | System.Windows.Forms.AnchorStyles.Left)
            | System.Windows.Forms.AnchorStyles.Right)));
            this.xtraTabControl1.Location = new System.Drawing.Point(12, 12);
            this.xtraTabControl1.Name = "xtraTabControl1";
            this.xtraTabControl1.SelectedTabPage = this.tabGeneral;
            this.xtraTabControl1.Size = new System.Drawing.Size(700, 330);
            this.xtraTabControl1.TabIndex = 0;
            this.xtraTabControl1.TabPages.AddRange(new DevExpress.XtraTab.XtraTabPage[] {
            this.tabGeneral,
            this.tabDetails});
            //
            // tabGeneral
            //
            this.tabGeneral.Controls.Add(this.simpleButtonSave);
            this.tabGeneral.Controls.Add(this.checkEditActive);
            this.tabGeneral.Controls.Add(this.comboBoxEditRole);
            this.tabGeneral.Controls.Add(this.textEditName);
            this.tabGeneral.Controls.Add(this.labelControlRole);
            this.tabGeneral.Controls.Add(this.labelControlName);
            this.tabGeneral.Name = "tabGeneral";
            this.tabGeneral.Size = new System.Drawing.Size(698, 302);
            this.tabGeneral.Text = "General";
            //
            // simpleButtonSave
            //
            this.simpleButtonSave.Location = new System.Drawing.Point(122, 176);
            this.simpleButtonSave.Name = "simpleButtonSave";
            this.simpleButtonSave.Size = new System.Drawing.Size(110, 28);
            this.simpleButtonSave.TabIndex = 5;
            this.simpleButtonSave.Text = "Save profile";
            //
            // checkEditActive
            //
            this.checkEditActive.Location = new System.Drawing.Point(122, 136);
            this.checkEditActive.Name = "checkEditActive";
            this.checkEditActive.Properties.Caption = "Active contributor";
            this.checkEditActive.Size = new System.Drawing.Size(160, 20);
            this.checkEditActive.TabIndex = 4;
            //
            // comboBoxEditRole
            //
            this.comboBoxEditRole.Location = new System.Drawing.Point(122, 96);
            this.comboBoxEditRole.Name = "comboBoxEditRole";
            this.comboBoxEditRole.Size = new System.Drawing.Size(260, 20);
            this.comboBoxEditRole.TabIndex = 3;
            //
            // textEditName
            //
            this.textEditName.Location = new System.Drawing.Point(122, 56);
            this.textEditName.Name = "textEditName";
            this.textEditName.Properties.NullValuePrompt = "e.g. Ada Lovelace";
            this.textEditName.Size = new System.Drawing.Size(260, 20);
            this.textEditName.TabIndex = 1;
            //
            // labelControlRole
            //
            this.labelControlRole.Location = new System.Drawing.Point(40, 99);
            this.labelControlRole.Name = "labelControlRole";
            this.labelControlRole.Size = new System.Drawing.Size(21, 13);
            this.labelControlRole.TabIndex = 2;
            this.labelControlRole.Text = "Role";
            //
            // labelControlName
            //
            this.labelControlName.Location = new System.Drawing.Point(40, 59);
            this.labelControlName.Name = "labelControlName";
            this.labelControlName.Size = new System.Drawing.Size(59, 13);
            this.labelControlName.TabIndex = 0;
            this.labelControlName.Text = "Display name";
            //
            // tabDetails
            //
            this.tabDetails.Controls.Add(this.memoEditNotes);
            this.tabDetails.Controls.Add(this.buttonEditFile);
            this.tabDetails.Controls.Add(this.labelControlFile);
            this.tabDetails.Name = "tabDetails";
            this.tabDetails.Size = new System.Drawing.Size(698, 302);
            this.tabDetails.Text = "Details";
            //
            // memoEditNotes
            //
            this.memoEditNotes.Location = new System.Drawing.Point(122, 96);
            this.memoEditNotes.Name = "memoEditNotes";
            this.memoEditNotes.Size = new System.Drawing.Size(420, 120);
            this.memoEditNotes.TabIndex = 2;
            //
            // buttonEditFile
            //
            this.buttonEditFile.Location = new System.Drawing.Point(122, 56);
            this.buttonEditFile.Name = "buttonEditFile";
            this.buttonEditFile.Size = new System.Drawing.Size(420, 20);
            this.buttonEditFile.TabIndex = 1;
            //
            // labelControlFile
            //
            this.labelControlFile.Location = new System.Drawing.Point(40, 59);
            this.labelControlFile.Name = "labelControlFile";
            this.labelControlFile.Size = new System.Drawing.Size(51, 13);
            this.labelControlFile.TabIndex = 0;
            this.labelControlFile.Text = "Report file";
            //
            // simpleButtonClose
            //
            this.simpleButtonClose.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Right)));
            this.simpleButtonClose.Location = new System.Drawing.Point(602, 356);
            this.simpleButtonClose.Name = "simpleButtonClose";
            this.simpleButtonClose.Size = new System.Drawing.Size(110, 28);
            this.simpleButtonClose.TabIndex = 2;
            this.simpleButtonClose.Text = "Close";
            //
            // frameworkButton
            //
            this.frameworkButton.Anchor = ((System.Windows.Forms.AnchorStyles)((System.Windows.Forms.AnchorStyles.Bottom | System.Windows.Forms.AnchorStyles.Left)));
            this.frameworkButton.Location = new System.Drawing.Point(12, 356);
            this.frameworkButton.Name = "frameworkButton";
            this.frameworkButton.Size = new System.Drawing.Size(190, 28);
            this.frameworkButton.TabIndex = 1;
            this.frameworkButton.Text = "Framework button";
            this.frameworkButton.UseVisualStyleBackColor = true;
            //
            // MainForm
            //
            this.ClientSize = new System.Drawing.Size(724, 396);
            this.Controls.Add(this.frameworkButton);
            this.Controls.Add(this.simpleButtonClose);
            this.Controls.Add(this.xtraTabControl1);
            this.Name = "MainForm";
            this.StartPosition = System.Windows.Forms.FormStartPosition.CenterScreen;
            this.Text = "DevExpress demo — designed in VS Code";
            ((System.ComponentModel.ISupportInitialize)(this.xtraTabControl1)).EndInit();
            this.xtraTabControl1.ResumeLayout(false);
            this.tabGeneral.ResumeLayout(false);
            this.tabGeneral.PerformLayout();
            ((System.ComponentModel.ISupportInitialize)(this.checkEditActive.Properties)).EndInit();
            ((System.ComponentModel.ISupportInitialize)(this.comboBoxEditRole.Properties)).EndInit();
            ((System.ComponentModel.ISupportInitialize)(this.textEditName.Properties)).EndInit();
            this.tabDetails.ResumeLayout(false);
            ((System.ComponentModel.ISupportInitialize)(this.memoEditNotes.Properties)).EndInit();
            ((System.ComponentModel.ISupportInitialize)(this.buttonEditFile.Properties)).EndInit();
            this.ResumeLayout(false);
        }

        private DevExpress.XtraTab.XtraTabControl xtraTabControl1;
        private DevExpress.XtraTab.XtraTabPage tabGeneral;
        private DevExpress.XtraTab.XtraTabPage tabDetails;
        private DevExpress.XtraEditors.LabelControl labelControlName;
        private DevExpress.XtraEditors.TextEdit textEditName;
        private DevExpress.XtraEditors.LabelControl labelControlRole;
        private DevExpress.XtraEditors.ComboBoxEdit comboBoxEditRole;
        private DevExpress.XtraEditors.CheckEdit checkEditActive;
        private DevExpress.XtraEditors.SimpleButton simpleButtonSave;
        private DevExpress.XtraEditors.LabelControl labelControlFile;
        private DevExpress.XtraEditors.ButtonEdit buttonEditFile;
        private DevExpress.XtraEditors.MemoEdit memoEditNotes;
        private DevExpress.XtraEditors.SimpleButton simpleButtonClose;
        private System.Windows.Forms.Button frameworkButton;
    }
}
