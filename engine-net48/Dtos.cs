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

    /// <summary>One toolbox palette entry. Mirrors WinFormsDesigner.Engine.ToolboxItemInfo (→ TS ToolboxItemInfo)
    /// so the merged palette JSON is identical regardless of which engine enumerated it. The net48 engine fills
    /// these for the project/vendor (DevExpress) assembly's own controls — the ones the net9 enumerator can't load —
    /// which the host merges with the net9 framework controls. Crosses the child-AppDomain boundary, so [Serializable]
    /// with plain get/set.</summary>
    [Serializable]
    public sealed class ToolboxItemInfo
    {
        public string Name { get; set; } = "";
        public string Fqn { get; set; } = "";
        public string Category { get; set; } = "";
        public bool FromProject { get; set; }
        /// <summary>The control's 16×16 [ToolboxBitmap] icon as a base64 PNG, or null when none is embedded /
        /// extraction failed. Display only.</summary>
        public string? IconPng { get; set; }
        /// <summary>True for a non-visual component (added to the tray). Always false here — net48 enumerates
        /// visual controls only — carried for DTO-shape parity with the net9 engine.</summary>
        public bool IsComponent { get; set; }
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
        /// <summary>True when this control is a tab host (has a TabPages collection + a SelectedTab/Page) — the
        /// webview uses it to route a header click to <c>SelectCompiledTabAt</c> so clicking a tab switches it.</summary>
        public bool IsTabHost { get; set; }
    }

    /// <summary>Result of a tab-header hit-test (rename): the .Designer.cs field id of the tab page under the point
    /// and its current Text. PageId is "" when no field-backed page was hit.</summary>
    [Serializable]
    public sealed class TabHit
    {
        public string PageId { get; set; } = "";
        public string Text { get; set; } = "";
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

    /// <summary>One item of a typed collection for the live reconstruction (T1.1b live picture on net48). A single
    /// [Serializable] superset carries all three editable collections keyed by the RPC's itemType: <see cref="Text"/>
    /// is the string value (Items) / column header (ListView Text, DataGridView HeaderText); <see cref="Width"/> and
    /// <see cref="Align"/> are ListView/DataGridView column props; <see cref="ReadOnly"/> / <see cref="Visible"/> are
    /// DataGridView-only. Fields the target type doesn't use are ignored. Crosses the child-AppDomain boundary, so
    /// plain get/set (no `init`).</summary>
    [Serializable]
    public sealed class LiveCollItem
    {
        /// <summary>Field name of an existing column ("" = a new one). Ignored for string Items.</summary>
        public string Id { get; set; } = "";
        /// <summary>String-item value, ListView column Text, or DataGridView column HeaderText.</summary>
        public string Text { get; set; } = "";
        /// <summary>Column width. ListView: set verbatim — 0 hides the column, -1/-2 are size-to-content/header sentinels.
        /// DataGridView: a width &lt;= 0 keeps the type default (a too-small width isn't settable). Unused for string Items.</summary>
        public int Width { get; set; }
        /// <summary>ListView column TextAlign member name ("Left"/"Center"/"Right"); "" = default. Unused otherwise.</summary>
        public string Align { get; set; } = "";
        /// <summary>DataGridView column ReadOnly. Unused for the other collections.</summary>
        public bool ReadOnly { get; set; }
        /// <summary>DataGridView column Visible (default true). Unused for the other collections.</summary>
        public bool Visible { get; set; } = true;
    }

    /// <summary>One TreeView node for the live tree reconstruction (net48 live node picture — the TreeView analogue of
    /// <see cref="LiveCollItem"/>). Recursive: <see cref="Children"/> are the sub-nodes. Only <see cref="Text"/> (the
    /// ctor label) and <see cref="Name"/> (the node key) are modelled — the same subset the net9 TreeNode editor
    /// round-trips — so a node with an image/checkbox/etc. never reaches here (the read side makes such a tree
    /// read-only). The host sends its `TreeNodeItem` shape verbatim; the extra `id` field is ignored on deserialize.
    /// Crosses the child-AppDomain boundary, so plain get/set (no `init`) + [Serializable].</summary>
    [Serializable]
    public sealed class LiveTreeNode
    {
        /// <summary>Node label (the TreeNode ctor's text argument).</summary>
        public string Text { get; set; } = "";
        /// <summary>Node key (TreeNode.Name); "" leaves it unset.</summary>
        public string Name { get; set; } = "";
        /// <summary>Child nodes, in order. Empty for a leaf.</summary>
        public LiveTreeNode[] Children { get; set; } = Array.Empty<LiveTreeNode>();
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
        /// <summary>The property's DescriptionAttribute text (VS description pane), or null when it has none.</summary>
        public string? Description { get; set; }
        /// <summary>True for a collection edited through the VS "…" collection editor (Items / typed Columns). The
        /// grid shows "(Collection)" + "…"; the read/write is routed to the net9 pure-text engine (parity with net9).</summary>
        public bool IsCollection { get; set; }
        /// <summary>Element type of an <see cref="IsCollection"/> property — "System.String" for Items, or the typed
        /// item FQN (ColumnHeader / DataGridViewColumn) that picks the webview's typed editor. Null when not a collection.</summary>
        public string? CollectionItemType { get; set; }
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
