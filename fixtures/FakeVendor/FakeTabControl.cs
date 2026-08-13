using System;
using System.Collections.ObjectModel;
using System.Drawing;
using System.Windows.Forms;

namespace FakeVendor
{
    /// <summary>A small DevExpress-shaped tab page used by the legally redistributable vendor corpus.</summary>
    public sealed class FakeTabPage : Panel
    {
    }

    public sealed class FakeTabHitInfo
    {
        public FakeTabHitInfo(FakeTabPage page) { Page = page; }
        public FakeTabPage Page { get; }
    }

    public sealed class FakeTabPageCollection : Collection<FakeTabPage>
    {
        private readonly FakeTabControl _owner;

        internal FakeTabPageCollection(FakeTabControl owner) { _owner = owner; }

        public void AddRange(FakeTabPage[] pages)
        {
            if (pages == null) throw new ArgumentNullException(nameof(pages));
            foreach (var page in pages) Add(page);
        }

        protected override void InsertItem(int index, FakeTabPage item)
        {
            if (item == null) throw new ArgumentNullException(nameof(item));
            if (Contains(item)) throw new ArgumentException("The tab page is already attached.", nameof(item));
            base.InsertItem(index, item);
            _owner.Controls.Add(item);
            _owner.SyncPages();
        }

        protected override void RemoveItem(int index)
        {
            var removed = this[index];
            base.RemoveItem(index);
            _owner.Controls.Remove(removed);
            _owner.PageRemoved(removed);
        }

        protected override void SetItem(int index, FakeTabPage item)
        {
            if (item == null) throw new ArgumentNullException(nameof(item));
            var removed = this[index];
            base.SetItem(index, item);
            _owner.Controls.Remove(removed);
            _owner.Controls.Add(item);
            _owner.PageRemoved(removed);
        }

        protected override void ClearItems()
        {
            var removed = new FakeTabPage[Count];
            CopyTo(removed, 0);
            base.ClearItems();
            foreach (var page in removed) _owner.Controls.Remove(page);
            _owner.PagesCleared();
        }
    }

    /// <summary>
    /// A redistributable stand-in for an XtraTabControl-style surface. It intentionally does not inherit TabControl:
    /// the engine must recognize the public TabPages + SelectedTabPage + CalcHitInfo contract reflectively.
    /// </summary>
    public sealed class FakeTabControl : Control
    {
        private const int HeaderHeight = 24;
        private const int HeaderWidth = 80;
        private FakeTabPage _selectedTabPage;

        public FakeTabControl()
        {
            TabPages = new FakeTabPageCollection(this);
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
        }

        public FakeTabPageCollection TabPages { get; }

        public FakeTabPage SelectedTabPage
        {
            get => _selectedTabPage;
            set
            {
                _selectedTabPage = value;
                SyncPages();
                Invalidate();
            }
        }

        public FakeTabHitInfo CalcHitInfo(Point point)
        {
            if (point.Y < 0 || point.Y >= HeaderHeight || point.X < 0) return new FakeTabHitInfo(null);
            int index = point.X / HeaderWidth;
            return new FakeTabHitInfo(index >= 0 && index < TabPages.Count ? TabPages[index] : null);
        }

        internal void PageRemoved(FakeTabPage page)
        {
            if (ReferenceEquals(_selectedTabPage, page)) _selectedTabPage = null;
            SyncPages();
        }

        internal void PagesCleared()
        {
            _selectedTabPage = null;
            SyncPages();
        }

        internal void SyncPages()
        {
            if (_selectedTabPage == null && TabPages.Count > 0) _selectedTabPage = TabPages[0];
            foreach (var page in TabPages)
            {
                page.SetBounds(1, HeaderHeight + 1, Math.Max(1, ClientSize.Width - 2), Math.Max(1, ClientSize.Height - HeaderHeight - 2));
                page.Visible = ReferenceEquals(page, _selectedTabPage);
            }
            PerformLayout();
            Invalidate();
        }

        protected override void OnSizeChanged(EventArgs e)
        {
            base.OnSizeChanged(e);
            SyncPages();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.Clear(SystemColors.Control);
            for (int i = 0; i < TabPages.Count; i++)
            {
                var rect = new Rectangle(i * HeaderWidth, 0, HeaderWidth, HeaderHeight);
                e.Graphics.FillRectangle(ReferenceEquals(TabPages[i], _selectedTabPage) ? SystemBrushes.Window : SystemBrushes.Control, rect);
                e.Graphics.DrawRectangle(SystemPens.ControlDark, rect);
                TextRenderer.DrawText(e.Graphics, TabPages[i].Text ?? "", Font, rect, SystemColors.ControlText,
                    TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
            }
            e.Graphics.DrawRectangle(SystemPens.ControlDark, 0, HeaderHeight, Math.Max(0, ClientSize.Width - 1), Math.Max(0, ClientSize.Height - HeaderHeight - 1));
        }
    }
}
