using System;
using System.Collections.Generic;

namespace WinFormsDesigner.Engine.Net48
{
    // DTO shapes mirror the net9 engine's WinFormsDesigner.Engine.{LayoutControl,RenderLayoutResult,...} so the
    // TS host reads identical camelCase JSON regardless of which engine answered. They also cross the child
    // AppDomain boundary (worker -> host), so every one is [Serializable] with plain get/set (no `init`, which
    // net48 lacks IsExternalInit for). A future refactor can hoist these into a shared netstandard2.0 assembly
    // referenced by both engines; duplicated here to ship the first increment without touching the net9 build.

    /// <summary>Engine self-description for the capability handshake — lets the host disable edit affordances
    /// and show an honest "compiled preview" badge for the net48 (render-first) engine.</summary>
    [Serializable]
    public sealed class EngineCapabilities
    {
        public string Engine { get; set; } = "";
        public bool Render { get; set; }
        public bool Edit { get; set; }
        /// <summary>Live preview of UNSAVED .Designer.cs edits. False for the compiled engine (needs rebuild).</summary>
        public bool LivePreviewUnsavedEdits { get; set; }
        public string Runtime { get; set; } = "";
        public string Notes { get; set; } = "";
    }

    /// <summary>One control's window-space placement + minimal tree info — the click-to-select hit-test unit.
    /// Mirrors WinFormsDesigner.Engine.LayoutControl.</summary>
    [Serializable]
    public sealed class LayoutControl
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public string? ParentId { get; set; }
        public bool IsRoot { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public int Depth { get; set; }
        public int TabIndex { get; set; }
        public string Anchor { get; set; } = "None";
        public string Dock { get; set; } = "None";
    }

    /// <summary>One property edit for the live batch-mutate (drag/resize/align): set componentId.propName to the
    /// invariant rawValue. Crosses the child-AppDomain boundary, so [Serializable] with plain get/set.</summary>
    [Serializable]
    public sealed class PropEdit
    {
        public string ComponentId { get; set; } = "this";
        public string PropName { get; set; } = "";
        public string RawValue { get; set; } = "";
    }

    /// <summary>One property row for the grid. Mirrors WinFormsDesigner.Engine.PropertyInfo (→ TS PropertyDesc).</summary>
    [Serializable]
    public sealed class PropertyDesc
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public string? Value { get; set; }
        public bool? IsDefault { get; set; }
        public bool SourceExplicit { get; set; }
        public bool ReadOnly { get; set; }
        public bool IsEnum { get; set; }
        public string Category { get; set; } = "Misc";
        public List<string>? StandardValues { get; set; }
        public bool StandardValuesExclusive { get; set; }
        public List<string>? FlagsMembers { get; set; }
        public string? FlagsZero { get; set; }
        public bool TableCell { get; set; }
        public bool IsImage { get; set; }
        public string? ImagePreview { get; set; }
    }

    /// <summary>One event row for the Events tab. Mirrors WinFormsDesigner.Engine.EventInfo (→ TS EventDesc).</summary>
    [Serializable]
    public sealed class EventDesc
    {
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public string Category { get; set; } = "Misc";
        public string? Handler { get; set; }
    }

    /// <summary>One component's property-grid + events data. Mirrors WinFormsDesigner.Engine.ComponentInfo (→ TS ComponentDesc).</summary>
    [Serializable]
    public sealed class ComponentDesc
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
        public string? Parent { get; set; }
        public bool IsRoot { get; set; }
        public List<PropertyDesc> Properties { get; set; } = new List<PropertyDesc>();
        public List<EventDesc> Events { get; set; } = new List<EventDesc>();
    }

    /// <summary>One non-visual component for the tray. Mirrors WinFormsDesigner.Engine.TrayComponent.</summary>
    [Serializable]
    public sealed class TrayComponent
    {
        public string Id { get; set; } = "";
        public string Name { get; set; } = "";
        public string Type { get; set; } = "";
    }

    /// <summary>Full-frame PNG + hit-test map from one instantiation. Mirrors WinFormsDesigner.Engine.RenderLayoutResult.
    /// TotalStatements/Representable/Unrepresentable are carried for shape-compatibility; the compiled path renders
    /// the real control (not an interpreted subset), so it reports Representable == TotalStatements and no gaps.</summary>
    [Serializable]
    public sealed class RenderLayoutResult
    {
        public byte[] Png { get; set; } = Array.Empty<byte>();
        public int Width { get; set; }
        public int Height { get; set; }
        public int ClientWidth { get; set; }
        public int ClientHeight { get; set; }
        public string RootType { get; set; } = "";
        public int TotalStatements { get; set; }
        public int Representable { get; set; }
        public List<string> Unrepresentable { get; set; } = new List<string>();
        public List<LayoutControl> Controls { get; set; } = new List<LayoutControl>();
        public List<TrayComponent> Tray { get; set; } = new List<TrayComponent>();
        /// <summary>For a live property edit: true when the value was applied to the live instance (picture reflects
        /// it); false when it couldn't be (unconvertible/read-only) — the text edit still persisted, the picture will
        /// catch up on rebuild. Always true for a plain render.</summary>
        public bool Applied { get; set; } = true;
        /// <summary>Non-fatal diagnostics (load reason, license note, why a live edit wasn't applied) for the host.</summary>
        public string Diagnostics { get; set; } = "";
    }
}
