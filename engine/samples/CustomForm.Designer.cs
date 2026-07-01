namespace SampleApp
{
    partial class CustomForm
    {
        private System.Windows.Forms.Label headerLabel;
        private CustomControls.GaugeControl cpuGauge;
        private CustomControls.GaugeControl memGauge;
        private System.Windows.Forms.Button refreshButton;

        private void InitializeComponent()
        {
            this.headerLabel = new System.Windows.Forms.Label();
            this.cpuGauge = new CustomControls.GaugeControl();
            this.memGauge = new CustomControls.GaugeControl();
            this.refreshButton = new System.Windows.Forms.Button();
            this.SuspendLayout();
            //
            // headerLabel
            //
            this.headerLabel.Location = new System.Drawing.Point(16, 12);
            this.headerLabel.Name = "headerLabel";
            this.headerLabel.Size = new System.Drawing.Size(367, 20);
            this.headerLabel.Text = "Мохнатая собака мандаринового цвета";
            //
            // cpuGauge
            //
            this.cpuGauge.Location = new System.Drawing.Point(16, 40);
            this.cpuGauge.Name = "cpuGauge";
            this.cpuGauge.Size = new System.Drawing.Size(240, 140);
            this.cpuGauge.Value = 85;
            //
            // memGauge
            //
            this.memGauge.Location = new System.Drawing.Point(270, 40);
            this.memGauge.Name = "memGauge";
            this.memGauge.Size = new System.Drawing.Size(240, 140);
            this.memGauge.Value = 47;
            //
            // refreshButton
            //
            this.refreshButton.Location = new System.Drawing.Point(343, 172);
            this.refreshButton.Name = "refreshButton";
            this.refreshButton.Size = new System.Drawing.Size(101, 27);
            this.refreshButton.Text = "Текст";
            //
            // CustomForm
            //
            this.ClientSize = new System.Drawing.Size(504, 263);
            this.Controls.Add(this.headerLabel);
            this.Controls.Add(this.cpuGauge);
            this.Controls.Add(this.memGauge);
            this.Controls.Add(this.refreshButton);
            this.Name = "CustomForm";
            this.Text = "Custom Form";
            this.ResumeLayout(false);
            this.PerformLayout();
        }
    }
}
