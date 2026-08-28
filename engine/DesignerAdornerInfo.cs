namespace WinFormsDesigner.Engine
{
    /// <summary>A bounded, control-local adorner rectangle published by an explicitly hosted ControlDesigner.</summary>
    public sealed class DesignerAdornerInfo
    {
        public string Id { get; init; } = "";
        public string DisplayName { get; init; } = "";
        public int Left { get; init; }
        public int Top { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
        public bool HitTestable { get; init; }
    }
}
