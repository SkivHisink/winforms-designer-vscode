namespace DemoApp
{
    partial class MainForm
    {
        private System.Windows.Forms.Label titleLabel;
        private CustomControls.GaugeControl diskGauge;
        private System.Windows.Forms.CheckBox autoRefresh;
        private System.Windows.Forms.Button closeButton;

        private void InitializeComponent()
        {
            this.titleLabel = new System.Windows.Forms.Label();
            this.diskGauge = new CustomControls.GaugeControl();
            this.autoRefresh = new System.Windows.Forms.CheckBox();
            this.closeButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // titleLabel
            //
            this.titleLabel.Location = new System.Drawing.Point(16, 12);
            this.titleLabel.Name = "titleLabel";
            this.titleLabel.Size = new System.Drawing.Size(320, 20);
            this.titleLabel.Text = "Disk usage (auto-discovered project build):";
            //
            // diskGauge
            //
            this.diskGauge.Location = new System.Drawing.Point(16, 40);
            this.diskGauge.Name = "diskGauge";
            this.diskGauge.Size = new System.Drawing.Size(240, 140);
            this.diskGauge.Value = 63;
            //
            // autoRefresh
            //
            this.autoRefresh.Location = new System.Drawing.Point(270, 50);
            this.autoRefresh.Name = "autoRefresh";
            this.autoRefresh.Size = new System.Drawing.Size(160, 24);
            this.autoRefresh.Text = "Auto refresh";
            this.autoRefresh.Checked = true;
            //
            // closeButton
            //
            this.closeButton.Location = new System.Drawing.Point(270, 150);
            this.closeButton.Name = "closeButton";
            this.closeButton.Size = new System.Drawing.Size(100, 30);
            this.closeButton.Text = "Close";
            //
            // MainForm
            //
            this.ClientSize = new System.Drawing.Size(400, 200);
            this.Controls.Add(this.titleLabel);
            this.Controls.Add(this.diskGauge);
            this.Controls.Add(this.autoRefresh);
            this.Controls.Add(this.closeButton);
            this.Name = "MainForm";
            this.Text = "Demo App";
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
