namespace WinFormsDesigner.Engine
{
    /// <summary>A bounded, control-local adorner rectangle published by an explicitly hosted ControlDesigner.
    /// Command identities are metadata for the host planner; neither a hit nor this DTO grants write authority.</summary>
    public sealed class DesignerAdornerInfo
    {
        public string Id { get; init; } = "";
        public string DisplayName { get; init; } = "";
        public int Left { get; init; }
        public int Top { get; init; }
        public int Width { get; init; }
        public int Height { get; init; }
        public bool HitTestable { get; init; }
        public string CommandId { get; init; } = "";
        public string KeyboardCommandId { get; init; } = "";
        public bool Enabled { get; init; }
        public string DisabledReasonCode { get; init; } = "render_only";
    }
}
