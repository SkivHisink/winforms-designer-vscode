using System;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

namespace CustomControls
{
    /// <summary>
    /// A custom UserControl with a real OnPaint. If the designer renders this gauge
    /// (arc, needle, label) rather than a grey placeholder, it proves real custom-control
    /// rendering via a collectible ALC — the core value proposition.
    /// </summary>
    public class GaugeControl : UserControl
    {
        private int _value = 72;

        public GaugeControl()
        {
            Size = new Size(240, 140);
            BackColor = Color.White;
            DoubleBuffered = true;
        }

        [DefaultValue(72)]
        public int Value
        {
            get => _value;
            set { _value = Math.Max(0, Math.Min(100, value)); Invalidate(); }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;

            var dial = new Rectangle(12, 12, 116, 116);
            g.FillEllipse(Brushes.Gainsboro, dial);
            using (var rim = new Pen(Color.SteelBlue, 5))
            {
                g.DrawEllipse(rim, dial);
            }
            // arc showing the value
            using (var arc = new Pen(Color.SeaGreen, 7))
            {
                g.DrawArc(arc, dial, 135f, 270f * _value / 100f);
            }
            // needle
            var center = new PointF(dial.X + dial.Width / 2f, dial.Y + dial.Height / 2f);
            double angle = Math.PI * (0.75 + 1.5 * _value / 100.0);
            var tip = new PointF(
                center.X + (float)(Math.Cos(angle) * 46),
                center.Y + (float)(Math.Sin(angle) * 46));
            using (var needle = new Pen(Color.Firebrick, 4))
            {
                g.DrawLine(needle, center, tip);
            }
            g.FillEllipse(Brushes.Firebrick, center.X - 5, center.Y - 5, 10, 10);

            using var font = new Font("Segoe UI", 13f, FontStyle.Bold);
            g.DrawString(_value + "%", font, Brushes.Black, 150, 46);
            using var small = new Font("Segoe UI", 9f);
            g.DrawString("custom gauge", small, Brushes.DimGray, 150, 74);
        }
    }
}
