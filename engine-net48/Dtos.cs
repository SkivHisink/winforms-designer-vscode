using System;
using System.Collections.Generic;

namespace WinFormsDesigner.Engine.Net48
{
    // DTO shapes mirror the net9 engine's WinFormsDesigner.Engine.{LayoutControl,RenderLayoutResult,...} so the
    // TS host reads identical camelCase JSON regardless of which engine answered. They also cross the child
    // AppDomain boundary (worker -> host), so every one is [Serializable] with plain get/set (no `init`, which
    // net48 lacks IsExternalInit for). A future refactor can hoist these into a shared netstandard2.0 assembly
    // referenced by both engines; duplicated here to ship the first increment without touching the net9 build.

    /// <summary>1.0.0 — outcome of releasing every held build output (the "release for rebuild" command). The host
    /// shows success only when Failed == 0; a non-zero Failed means some AppDomain refused to unload and is still
    /// pinning the user's dlls, so the host recycles the whole net48 engine process to free them.</summary>
    [Serializable]
    public sealed class ReleaseResult
    {
        public int Attempted { get; set; }
        public int Released { get; set; }
        public int Failed { get; set; }
    }

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

    /// <summary>One entry of a vendor control's DECLARED smart-tag menu (the DevExpress "XtraTabControl Tasks"
    /// panel), read off the compiled type's attributes — see VendorSmartTags for why this is metadata-only and the
    /// vendor's action is never invoked. Display + identity only: the host decides which verbs it can honour with its
    /// own source-first edit and shows the rest disabled. Crosses the child-AppDomain boundary → [Serializable].</summary>
    [Serializable]
    public sealed class VendorSmartTag
    {
        /// <summary>The vendor's own label, exactly as its panel shows it ("Add Tab Page").</summary>
        public string DisplayName { get; set; } = "";
        /// <summary>The verb's method name on the vendor actions class ("AddTabPage") — the host's mapping key.</summary>
        public string MethodName { get; set; } = "";
        /// <summary>FQN of the vendor's actions class ("DevExpress.XtraEditors.XtraTabControlActions"); "" if unreadable.
        /// Diagnostic only — never loaded or invoked.</summary>
        public string ActionsType { get; set; } = "";
        /// <summary>The vendor's declared sort key; -1 (the default) for every action shipped today.</summary>
        public int SortOrder { get; set; }
        /// <summary>Vendor flagged the verb CloseAfterExecute — its panel closes once the action runs.</summary>
        public bool ClosesPanel { get; set; }
        /// <summary>Order the attribute appears on the type; the tie-break that reproduces the vendor's panel order.</summary>
        public int DeclarationIndex { get; set; }
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
        /// <summary>True when this control is a ToolStrip/MenuStrip/StatusStrip — the canvas routes clicks on it into
        /// on-canvas item mode ("Type Here" add / item rename / delete). Mirrors WinFormsDesigner.Engine.LayoutControl.</summary>
        public bool IsStripHost { get; set; }
    }

    /// <summary>One TOP-LEVEL ToolStrip/MenuStrip/StatusStrip item's window-space rectangle (or the trailing "Type Here"
    /// slot). Mirrors WinFormsDesigner.Engine.ToolStripItemBounds. Nested/submenu items have no bounds (a closed DropDown
    /// isn't laid out), but ride along in <see cref="Children"/> (id/text/type) so the canvas can draw a synthetic
    /// flyout and reach their Properties via the item→Properties channel.</summary>
    [Serializable]
    public sealed class ToolStripItemBounds
    {
        public string OwnerId { get; set; } = "";
        public string ItemId { get; set; } = "";
        public string ItemType { get; set; } = "";
        public string Text { get; set; } = "";
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool IsTypeHere { get; set; }
        /// <summary>True for the strip's OVERFLOW chevron button (bounds-carrying, id-less); its <see cref="Children"/> are
        /// the overflow-placed items. Mirrors the net9 DTO. When set the strip is full → no "Type Here" slot is emitted.</summary>
        public bool Overflow { get; set; }
        /// <summary>Nested DropDownItems (recursive; id/text/type only — no bounds). Mirrors the net9 DTO. Empty for
        /// leaf items, separators, and the "Type Here" slot.</summary>
        public List<ToolStripItemBounds> Children { get; set; } = new List<ToolStripItemBounds>();
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
    /// <see cref="LiveCollItem"/>). Recursive: <see cref="Children"/> are the sub-nodes. <see cref="Text"/> (the ctor
    /// label), <see cref="Name"/> (the node key) and the four image props are modelled — the same subset the net9
    /// TreeNode editor round-trips. The image is drawn automatically by WinForms from the compiled TreeView's ImageList
    /// once the key/index is set. The host sends its `TreeNodeItem` shape verbatim; the extra `id` field is ignored on
    /// deserialize. Crosses the child-AppDomain boundary, so plain get/set (no `init`) + [Serializable].</summary>
    [Serializable]
    public sealed class LiveTreeNode
    {
        /// <summary>Node label (the TreeNode ctor's text argument).</summary>
        public string Text { get; set; } = "";
        /// <summary>Node key (TreeNode.Name); "" leaves it unset.</summary>
        public string Name { get; set; } = "";
        /// <summary>TreeNode image props. Defaults match WinForms ('no image' = "" key / -1 index) — an omitted field
        /// keeps the default across the JSON boundary. Key and index are mutually exclusive; key-first on apply.</summary>
        public string ImageKey { get; set; } = "";
        public int ImageIndex { get; set; } = -1;
        public string SelectedImageKey { get; set; } = "";
        public int SelectedImageIndex { get; set; } = -1;
        /// <summary>Other scalar node props. Defaults match WinForms ("" tooltip / unchecked) — an omitted field keeps
        /// the default across the JSON boundary.</summary>
        public string ToolTipText { get; set; } = "";
        public bool Checked { get; set; } = false;
        /// <summary>Visual-style node props as property-grid invariant strings ("Red" / "64, 128, 255" / "Segoe UI,
        /// 9pt, style=Bold"); "" = unset. Converted to a live Color/Font via the framework TypeConverter on apply.</summary>
        public string ForeColor { get; set; } = "";
        public string BackColor { get; set; } = "";
        public string NodeFont { get; set; } = "";
        /// <summary>Child nodes, in order. Empty for a leaf.</summary>
        public LiveTreeNode[] Children { get; set; } = Array.Empty<LiveTreeNode>();
    }

    /// <summary>One ToolStrip/MenuStrip item for the live item reconstruction (net48 live add/remove/rename/reorder —
    /// the ToolStrip analogue of <see cref="LiveTreeNode"/>). Recursive: <see cref="Children"/> are the nested
    /// DropDownItems of a menu/split/dropdown item. Unlike TreeNodes, ToolStrip items are PERSISTED FIELDS that may
    /// carry unmodelled props (Image, event wiring), so the worker mutates the live collection SURGICALLY keyed by
    /// <see cref="Id"/> (the .Designer.cs field name) — reusing an existing item object, creating one only for a new
    /// id — instead of Clear()+rebuild. The host sends the net9-committed forest (every id resolved, incl. minted
    /// ids for "Type Here" adds), so <see cref="Id"/> is always populated here. <see cref="ItemType"/> is the short
    /// type name (ToolStripButton/…), used only when an item must be constructed; a separator carries no Text.
    /// Crosses the child-AppDomain boundary, so plain get/set (no `init`) + [Serializable].</summary>
    [Serializable]
    public sealed class LiveToolStripItem
    {
        /// <summary>The item's .Designer.cs field name — the identity key the live reconcile matches on.</summary>
        public string Id { get; set; } = "";
        /// <summary>Display caption (ToolStripItem.Text). Empty for a separator or an untitled item.</summary>
        public string Text { get; set; } = "";
        /// <summary>ToolStripItem.Name; informational — the reconcile keys on <see cref="Id"/>, not Name.</summary>
        public string Name { get; set; } = "";
        /// <summary>Short concrete type name (ToolStripMenuItem/ToolStripButton/ToolStripSeparator/…). Used to
        /// construct a NEW item (matched to the engine's allowlist); ignored for an existing, reused item.</summary>
        public string ItemType { get; set; } = "";
        /// <summary>Nested DropDownItems, in order. Empty for a leaf item.</summary>
        public LiveToolStripItem[] Children { get; set; } = Array.Empty<LiveToolStripItem>();
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
        /// <summary>True for a component-reference property (ReferenceConverter: AcceptButton/CancelButton/
        /// ContextMenuStrip). StandardValues are the compatible sibling field names + a leading "(none)"; the host
        /// translates a pick to `this.&lt;name&gt;` / `null`. Parity with net9's PropertyInfo.ReferenceValues.</summary>
        public bool ReferenceValues { get; set; }
        /// <summary>True for a source-backed design-time pseudo-property (Modifiers / GenerateMember).</summary>
        public bool DesignTime { get; set; }
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
        /// <summary>Host-only guard: ToolStripItem properties use the item edit channel and must not receive
        /// control-field Modifiers pseudo-properties.</summary>
        public bool IsToolStripItem { get; set; }
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
        /// <summary>For an OFF-TREE ToolStrip surfaced in the tray (a ContextMenuStrip), its top-level Items as a
        /// BOUNDS-LESS forest (id/text/type + recursive Children) so the canvas can open a synthetic flyout from the
        /// tray chip. Mirrors WinFormsDesigner.Engine.TrayComponent.Items. Empty for a non-strip component.</summary>
        public List<ToolStripItemBounds> Items { get; set; } = new List<ToolStripItemBounds>();
        /// <summary>True when this tray component is a ToolStrip (a ContextMenuStrip / off-tree strip) — the canvas opens
        /// its synthetic items flyout on a chip click, and an EMPTY strip still gets a "Type Here" add-first-item flyout
        /// (a non-strip component's empty Items is otherwise indistinguishable). Mirrors WinFormsDesigner.Engine.TrayComponent.IsStrip.</summary>
        public bool IsStrip { get; set; }
    }

    /// <summary>Full-frame PNG + hit-test map from one instantiation. Mirrors WinFormsDesigner.Engine.RenderLayoutResult.
    /// TotalStatements/Representable/Unrepresentable are carried for shape-compatibility; the compiled path renders
    /// the real control (not an interpreted subset), so it reports Representable == TotalStatements and no gaps.</summary>
    [Serializable]
    public sealed class RenderLayoutResult
    {
        /// <summary>DIAGNOSTIC-ONLY — identity of the live compiled instance this result was drawn from. Changes
        /// whenever the instance is (re)created: explicit discard, engine crash, control-source change, hot-exit
        /// recovery, or DomainManager unloading the AppDomain because the target assembly was rebuilt. The host's
        /// divergence LOCK built on these ids was descoped (the unconditional "last build"
        /// disclosure replaced it); the host reads them only for diagnostics/e2e. Empty when no instance produced
        /// the result.</summary>
        public string LiveInstanceId { get; set; } = "";
        /// <summary>DIAGNOSTIC-ONLY — identity of the compiled BUILD this instance came from (assembly mtime+length;
        /// NOT a content hash — a same-second same-length rebuild is indistinguishable, which is one reason the
        /// divergence lock was descoped). A new LiveInstanceId on the SAME LiveBuildId is a reload of the same stale
        /// build; a new LiveBuildId is a genuine rebuild. See LiveDesign.</summary>
        public string LiveBuildId { get; set; } = "";
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
        /// <summary>Per-item geometry for every top-level strip item + a trailing "Type Here" slot per strip.</summary>
        public List<ToolStripItemBounds> ToolStripItems { get; set; } = new List<ToolStripItemBounds>();
        /// <summary>For a live property edit: true when the value was applied to the live instance (picture reflects
        /// it); false when it couldn't be (unconvertible/read-only) — the text edit still persisted, the picture will
        /// catch up on rebuild. Always true for a plain render.</summary>
        public bool Applied { get; set; } = true;
        /// <summary>Non-fatal diagnostics (load reason, license note, why a live edit wasn't applied) for the host.</summary>
        public string Diagnostics { get; set; } = "";
        /// <summary>Which net48 render produced this: "compiled" (the last build, default),
        /// "interpreted" (the live source via the IR interpreter — VS model), or "compiledFallback" (the interpreter
        /// couldn't cover this form, so the compiled last build is shown WITH <see cref="FallbackReason"/>). The host
        /// drives the two-axis mode (engineKind × renderMode) and the banner from this.</summary>
        public string RenderMode { get; set; } = "compiled";
        /// <summary>A stable RenderFallbackReason code when RenderMode=="compiledFallback"; "" otherwise.</summary>
        public string FallbackReason { get; set; } = "";
    }
}
