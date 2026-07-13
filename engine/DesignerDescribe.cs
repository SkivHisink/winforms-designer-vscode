using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Linq;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine
{
    public sealed class PropertyInfo
    {
        public string Name { get; init; } = "";
        public string Type { get; init; } = "";
        /// <summary>Current value as an invariant string, or null if null / not invariantly convertible.</summary>
        public string? Value { get; init; }
        /// <summary>
        /// TypeDescriptor.ShouldSerializeValue == false (raw "has a non-default value"); null when it could
        /// not be determined. NOTE: over-reports standalone-host noise (Visible/Enabled/collections) — for a
        /// grid's "set in source" bold use <see cref="SourceExplicit"/> instead.
        /// </summary>
        public bool? IsDefault { get; init; }
        /// <summary>True when this property was explicitly assigned in the source .Designer.cs (grid bold signal).</summary>
        public bool SourceExplicit { get; init; }
        public bool ReadOnly { get; init; }
        /// <summary>Enum type — lets the editor build a fully-qualified `Type.Member` C# expression.</summary>
        public bool IsEnum { get; init; }
        public string Category { get; init; } = "Misc";
        /// <summary>The property's DescriptionAttribute text (fills the VS description pane below the grid), or
        /// null when the property carries no description.</summary>
        public string? Description { get; init; }
        /// <summary>The property's TypeConverter standard values as invariant strings (dropdowns), or null
        /// when the converter exposes none. Populated for enums (non-flags), Boolean, named Colors, etc. Flags
        /// enums are left null (a single-select can't represent "Top, Left") → the editor keeps a text input.</summary>
        public List<string>? StandardValues { get; init; }
        /// <summary>True when the standard-values set is closed (TypeConverter.GetStandardValuesExclusive) → the
        /// editor renders a &lt;select&gt;; false → an editable combobox (datalist) that also accepts free text.</summary>
        public bool StandardValuesExclusive { get; init; }
        /// <summary>For a [Flags] enum: the individual single-bit member names (e.g. Top/Bottom/Left/Right for
        /// AnchorStyles), so the grid can render a checkbox dropdown that composes "Top, Left". Null for
        /// non-flags enums / non-enums. Anchor keeps its dedicated visual editor; other flags enums use these.
        /// StandardValues is intentionally null for flags (a single-select can't express combined flags).</summary>
        public List<string>? FlagsMembers { get; init; }
        /// <summary>For a [Flags] enum: the name of its zero-valued member (e.g. "None"), so the checkbox
        /// dropdown can commit a valid value when the user unchecks everything. Null when the enum has no
        /// zero member (rare — most WinForms flags enums define None=0).</summary>
        public string? FlagsZero { get; init; }
        /// <summary>True for a TableLayoutPanel child's Column/Row extender (surfaced despite its Hidden
        /// serialization-visibility). The grid edits these via SetTableCell — which rewrites the 3-arg
        /// Controls.Add cell args — NOT a normal property assignment. Display + edit-routing signal.</summary>
        public bool TableCell { get; init; }
        /// <summary>True when the property's value type is an image/icon (System.Drawing.Image/Bitmap/Icon). Its
        /// value is not a literal (<see cref="Value"/> stays null), so the grid renders a preview swatch +
        /// Import…/(none) editor (resx-backed) instead of a text field. Edit-routing + display signal.</summary>
        public bool IsImage { get; init; }
        /// <summary>A small base64 PNG thumbnail of the current image value (max 64×64, aspect-preserved), or null
        /// when the property is unset / not an image / couldn't be rendered. Display-only; never disposes the live value.</summary>
        public string? ImagePreview { get; init; }
        /// <summary>True for a string-item collection (ComboBox/ListBox/CheckedListBox.Items) surfaced with the VS
        /// "String Collection Editor" (a "…" button opening a one-item-per-line editor). Edits route through
        /// SetCollectionItems (rewrites the owner's Add/AddRange calls), NOT a normal property assignment.</summary>
        public bool IsCollection { get; init; }
        /// <summary>The collection's item type for the editor (currently always "System.String"), or null when the
        /// property is not an editable collection.</summary>
        public string? CollectionItemType { get; init; }
        /// <summary>True for a component-reference property (a ReferenceConverter target: Form.AcceptButton/
        /// CancelButton, Control.ContextMenuStrip, …). Its <see cref="StandardValues"/> are the compatible sibling
        /// component field names + a leading "(none)" — self-enumerated from the container (the converter needs a
        /// design container to list them, which a plain runtime instance lacks). The grid renders the dropdown; the
        /// host translates a pick to `this.&lt;name&gt;` / `null` on write (net9 splice, net48 live resolve).</summary>
        public bool ReferenceValues { get; init; }
    }

    /// <summary>One event of a component, for the Events tab. <see cref="Handler"/> is the wired handler
    /// method name parsed from the source (<c>this.btn.Click += new EventHandler(this.btn_Click)</c> →
    /// "btn_Click"), or null when the event has no handler.</summary>
    public sealed class EventInfo
    {
        public string Name { get; init; } = "";
        /// <summary>The delegate type (e.g. System.EventHandler) — for a future "generate handler" stub.</summary>
        public string Type { get; init; } = "";
        public string Category { get; init; } = "Misc";
        /// <summary>Wired handler method name from the source, or null if unhandled.</summary>
        public string? Handler { get; init; }
    }

    public sealed class ComponentInfo
    {
        /// <summary>Edit id to pass to SetProperty: "this" for the root, Site.Name for other components.</summary>
        public string Id { get; init; } = "";
        /// <summary>Display name: the class name for the root, Site.Name for other components.</summary>
        public string Name { get; init; } = "";
        public string Type { get; init; } = "";
        /// <summary>Parent component display name, or null for the root.</summary>
        public string? Parent { get; init; }
        public bool IsRoot { get; init; }
        public List<PropertyInfo> Properties { get; init; } = new();
        /// <summary>The component's events (name + category + wired handler) — the Events-tab data.</summary>
        public List<EventInfo> Events { get; init; } = new();
    }

    public sealed class DescribeResult
    {
        public string RootType { get; init; } = "";
        public List<ComponentInfo> Components { get; init; } = new();
        public int TotalStatements { get; init; }
        public int Representable { get; init; }
        public List<string> Unrepresentable { get; init; } = new();
        public bool RoundTripSafe => Unrepresentable.Count == 0;
    }

    /// <summary>
    /// Enumerates a loaded designer graph into a serializable description (controls + their browsable
    /// properties with current values) — the read-side data layer behind a property grid. Pairs with
    /// <see cref="DesignerPropertyEditor"/> for the write side: the grid reads here (selection →
    /// properties) and writes via SetProperty using <see cref="ComponentInfo.Id"/>.
    ///
    /// Two entry points: <see cref="Describe"/> (whole form) for CLI/overview, and
    /// <see cref="DescribeComponent"/> (one component) — the bounded path a grid should use per
    /// selection so a hostile/slow third-party property getter can't be triggered across every control
    /// at once. (A true hang-guard for a stuck getter still needs a process-level watchdog — boundary.)
    /// </summary>
    public static class DesignerDescribe
    {
        public static DescribeResult Describe(IDesignerHost host, string rootName,
            HashSet<(IComponent, string)> explicitMembers,
            int total, int representable, List<string> unrepresentable,
            Dictionary<string, Dictionary<string, string>>? eventWirings = null)
        {
            var root = host.RootComponent;
            var all = host.Container.Components.Cast<IComponent>().ToList();
            // Reference-dropdown candidates: every sited component EXCEPT the root form — a field-backed component the
            // write can name as `this.<field>`. The root is `this` (no field), never a `this.<name>` reference target,
            // so exclude it (matches the net48 side, whose FieldNames map holds no root entry).
            var siblings = all.Where(x => !ReferenceEquals(x, root)).ToList();
            var components = all
                .Select(c => BuildComponentInfo(c, root, rootName, explicitMembers, eventWirings, siblings))
                .OrderByDescending(c => c.IsRoot)
                .ThenBy(c => c.Name, StringComparer.Ordinal)
                .ToList();

            return new DescribeResult
            {
                RootType = root.GetType().FullName ?? root.GetType().Name,
                Components = components,
                TotalStatements = total,
                Representable = representable,
                Unrepresentable = unrepresentable,
            };
        }

        /// <summary>Describe a single component by edit id ("this" = root). null if not found.</summary>
        public static ComponentInfo? DescribeComponent(IDesignerHost host, string rootName,
            HashSet<(IComponent, string)> explicitMembers, string componentId,
            Dictionary<string, Dictionary<string, string>>? eventWirings = null)
        {
            var root = host.RootComponent;
            var all = host.Container.Components.Cast<IComponent>().ToList();
            var siblings = all.Where(x => !ReferenceEquals(x, root)).ToList(); // see Describe: root is never a `this.<field>` reference target
            IComponent? target = (componentId is "this" or "")
                ? root
                : all.FirstOrDefault(c => c.Site?.Name == componentId);
            return target == null ? null : BuildComponentInfo(target, root, rootName, explicitMembers, eventWirings, siblings);
        }

        private static ComponentInfo BuildComponentInfo(IComponent c, IComponent root, string rootName,
            HashSet<(IComponent, string)> explicitMembers,
            Dictionary<string, Dictionary<string, string>>? eventWirings,
            IReadOnlyList<IComponent> siblings)
        {
            bool isRoot = ReferenceEquals(c, root);
            string idKey = isRoot ? "this" : (c.Site?.Name ?? "");
            Dictionary<string, string>? wired = null;
            eventWirings?.TryGetValue(idKey, out wired);
            return new ComponentInfo
            {
                Id = idKey,
                Name = isRoot ? rootName : (c.Site?.Name ?? ""),
                Type = c.GetType().FullName ?? c.GetType().Name,
                Parent = ParentName(c, root, rootName),
                IsRoot = isRoot,
                Properties = DescribeProperties(c, explicitMembers, siblings, root),
                Events = DescribeEvents(c, wired),
            };
        }

        /// <summary>Enumerate a component's browsable events (name + delegate type + category) with the
        /// handler method wired in the source (if any) — the Events-tab data.</summary>
        private static List<EventInfo> DescribeEvents(IComponent c, Dictionary<string, string>? wired)
        {
            var list = new List<EventInfo>();
            foreach (EventDescriptor ed in TypeDescriptor.GetEvents(c))
            {
                if (!ed.IsBrowsable) continue;
                string? handler = null;
                wired?.TryGetValue(ed.Name, out handler);
                list.Add(new EventInfo
                {
                    Name = ed.Name,
                    Type = ed.EventType.FullName ?? ed.EventType.Name,
                    Category = string.IsNullOrEmpty(ed.Category) ? "Misc" : ed.Category,
                    Handler = handler,
                });
            }
            list.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return list;
        }

        private static string? ParentName(IComponent c, IComponent root, string rootName)
        {
            if (ReferenceEquals(c, root)) return null;
            if (c is Control ctl && ctl.Parent is Control p)
            {
                return ReferenceEquals(p, root) ? rootName : (p.Site?.Name ?? "");
            }
            return null;
        }

        private static List<PropertyInfo> DescribeProperties(IComponent c, HashSet<(IComponent, string)> explicitMembers,
            IReadOnlyList<IComponent> siblings, IComponent root)
        {
            var list = new List<PropertyInfo>();
            // a child sited directly in a TableLayoutPanel exposes the panel's Column/Row extender properties; they
            // carry [DesignerSerializationVisibility(Hidden)] (the 3-arg Controls.Add is their serialization), so the
            // Hidden filter below would drop them — surface them anyway and route their edits through SetTableCell.
            bool parentIsTlp = c is Control pctl && pctl.Parent is System.Windows.Forms.TableLayoutPanel;
            foreach (PropertyDescriptor pd in TypeDescriptor.GetProperties(c))
            {
                bool isTableCell = parentIsTlp && (pd.Name == "Column" || pd.Name == "Row");
                // string-item collections (ComboBox/ListBox/CheckedListBox.Items) are surfaced for the collection
                // editor even though Items is [Browsable(false)] + Hidden serialization — the grid needs them.
                bool isStringCollection = IsStringCollectionProperty(pd);
                string? typedCollectionItem = TypedCollectionItemType(pd);
                // a generic writable string[] property (flagship: TextBox/RichTextBox.Lines) is surfaced through the
                // SAME "…" editor as the string collections, but marked with the distinct CollectionItemType sentinel
                // "System.String[]" so the host routes it to the string-array RPCs (a single `= new string[]{…}`
                // assignment) rather than the Items.Add/AddRange splicer. Gate on a real setter — a getter-only
                // string[] (computed) would show editable but never apply.
                bool isStringArray = pd.PropertyType.FullName == "System.String[]" && !pd.IsReadOnly;
                bool isCollection = isStringCollection || typedCollectionItem != null || isStringArray;
                if (!pd.IsBrowsable && !isTableCell && !isCollection) continue;
                var vis = (DesignerSerializationVisibilityAttribute?)pd.Attributes[typeof(DesignerSerializationVisibilityAttribute)];
                if (vis != null && vis.Visibility == DesignerSerializationVisibility.Hidden && !isTableCell && !isCollection) continue;

                // 0.11.0 minimal (Collection) routing — an editable collection the designer serializes inline
                // (DesignerSerializationVisibility.Content + IList) that we DON'T have a bespoke editor for reaches the
                // grid here (Browsable + not Hidden). Rather than showing its useless ToString (the collection's type
                // name), surface a clean READ-ONLY "(Collection)" entry: VS parity (the property is visible), fail-closed
                // (no edit path = no data-loss / no broken "…"). A dedicated generic list editor is the deferred XL work.
                bool unhandledCollection = !isCollection && !isTableCell
                    && vis != null && vis.Visibility == DesignerSerializationVisibility.Content
                    && typeof(System.Collections.IList).IsAssignableFrom(pd.PropertyType);

                // read value and default-state in SEPARATE guarded blocks: a throwing ShouldSerializeValue
                // must not discard a value that read fine, and vice versa.
                object? raw = null;
                try { raw = pd.GetValue(c); }
                catch { raw = null; }

                string? value = null;
                try { value = StringifyInvariant(pd, raw); }
                catch { value = null; }

                bool? isDefault = null;
                try { isDefault = !pd.ShouldSerializeValue(c); }
                catch { isDefault = null; }

                // The grid edits a Font through its invariant string, but FontConverter's string form omits
                // GdiCharSet/GdiVerticalFont — so editing a Font that carries a non-default charset (e.g. 204 =
                // RUSSIAN_CHARSET, common in Cyrillic/CJK forms) would silently drop the charset on save. Show
                // such a Font read-only so the value can't be lost; plain fonts (charset 1) stay editable.
                bool readOnly = pd.IsReadOnly || unhandledCollection; // an unhandled collection has no edit path → read-only
                if (raw is System.Drawing.Font font && (font.GdiCharSet != 1 || font.GdiVerticalFont))
                {
                    readOnly = true;
                }

                var (standardValues, stdExclusive) = StandardValuesOf(pd, c);

                // Component-reference property (ReferenceConverter: AcceptButton/CancelButton/ContextMenuStrip…): the
                // converter can only enumerate the compatible siblings with a design container (a plain runtime
                // instance has none), so self-enumerate the container. Overrides any (empty) standard-values from the
                // context-less converter above, forces an exclusive dropdown, and rewrites value to the referenced
                // field name (the SAME name source as the options → the current value pre-selects; the converter's
                // ToString on a non-sited instance would not).
                bool referenceValues = false;
                var refInfo = ReferenceValuesOf(pd, c, raw, siblings, root);
                if (refInfo != null)
                {
                    standardValues = refInfo.Value.values;
                    stdExclusive = true;
                    referenceValues = true;
                    value = refInfo.Value.current;
                }

                // Cursor: only a STANDARD cursor (Cursors.Hand, …) round-trips through the picker; editing a
                // custom/resx/.cur cursor would silently replace it with a standard one. Mirror the Font-charset
                // guard above — show it read-only unless the current value is one of the offered standard names.
                if (pd.PropertyType.FullName == "System.Windows.Forms.Cursor"
                    && (standardValues == null || value == null || !standardValues.Contains(value)))
                {
                    readOnly = true;
                }

                // Image/Icon properties (BackgroundImage, PictureBox.Image, Form.Icon…): the value isn't a
                // literal, so surface a thumbnail preview + the resx-backed Import…/(none) editor instead of text.
                bool isImage = IsImageProperty(pd.PropertyType);
                string? imagePreview = isImage ? TryThumbnail(raw) : null;

                // guarded like the value reads above — a third-party PropertyDescriptor's Description getter is user
                // code that can throw; a failure must degrade this one field to null, not abort the whole grid.
                string? description = null;
                try { description = string.IsNullOrEmpty(pd.Description) ? null : pd.Description; } catch { description = null; }

                list.Add(new PropertyInfo
                {
                    Name = pd.Name,
                    Type = pd.PropertyType.FullName ?? pd.PropertyType.Name,
                    // a collection's live value isn't a literal — the "…" editor drives it, so leave Value null; an
                    // unhandled (read-only) collection shows the clean "(Collection)" placeholder instead of its ToString.
                    Value = isCollection ? null : (unhandledCollection ? "(Collection)" : value),
                    IsDefault = isDefault,
                    SourceExplicit = explicitMembers.Contains((c, pd.Name)),
                    ReadOnly = readOnly,
                    IsEnum = pd.PropertyType.IsEnum,
                    Category = string.IsNullOrEmpty(pd.Category) ? "Misc" : pd.Category,
                    Description = description,
                    StandardValues = standardValues,
                    StandardValuesExclusive = stdExclusive,
                    FlagsMembers = FlagsMembersOf(pd.PropertyType),
                    FlagsZero = FlagsZeroOf(pd.PropertyType),
                    TableCell = isTableCell,
                    IsImage = isImage,
                    ImagePreview = imagePreview,
                    IsCollection = isCollection,
                    CollectionItemType = isStringArray ? "System.String[]" : (isStringCollection ? "System.String" : typedCollectionItem),
                    ReferenceValues = referenceValues,
                });
            }
            list.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return list;
        }

        /// <summary>The property's TypeConverter standard values as invariant strings + whether the set is
        /// exclusive (closed). Returns (null, false) when none are offered, the type is a flags enum (a
        /// single-select can't express combined flags), or any value fails to stringify. Bounded and fully
        /// guarded — a hostile converter degrades to no dropdown, never throws.</summary>
        private static (List<string>?, bool) StandardValuesOf(PropertyDescriptor pd, IComponent owner)
        {
            try
            {
                if (pd.PropertyType.IsEnum && pd.PropertyType.IsDefined(typeof(FlagsAttribute), false)) return (null, false);
                var conv = pd.Converter;
                if (conv == null) return (null, false);
                // ONLY the WinForms ImageIndex / ImageKey converters get a describe-time context (Instance = the component,
                // PropertyDescriptor = pd) — they read the control's ATTACHED ImageList off context.Instance to enumerate its
                // indices / keys. Every OTHER converter uses the context-less path, EXACTLY as before. GATE on the WinForms
                // ASSEMBLY (not just the type name): catches ImageIndexConverter / ImageKeyConverter AND the internal
                // NoneExcludedImageIndexConverter / TreeViewImage*Converter variants, but NOT a same-named third-party
                // converter — which must never receive a live, mutation-capable context during a read-only describe (codex).
                string convName = conv.GetType().Name;
                bool isImageConv = (convName.EndsWith("ImageIndexConverter", StringComparison.Ordinal) || convName.EndsWith("ImageKeyConverter", StringComparison.Ordinal))
                    && ReferenceEquals(conv.GetType().Assembly, typeof(Control).Assembly);
                ITypeDescriptorContext? ctx = null;
                if (isImageConv) { try { ctx = new DescribeContext(owner, pd); } catch { ctx = null; } }
                var coll = StandardValuesColl(conv, ctx);
                if (coll == null) return (null, false);
                var vals = new List<string>();
                foreach (var sv in coll)
                {
                    if (sv == null) continue;
                    // Skip the image converters' "no image" SENTINEL (ImageKey ""→display "(none)", ImageIndex -1→"(none)"):
                    // that display string does NOT round-trip through the primitive write path — it would splice a stale key
                    // literally named "(none)", or reject the non-numeric int — so offer only REAL, committable keys/indices
                    // (codex). Filter by the ACTUAL value (empty string / negative int), NOT the display, so a legitimate key
                    // literally "(none)" is preserved. (Clearing to no-image is via Reset, not the dropdown, until a
                    // value/display DTO lands.)
                    if (isImageConv && ((sv is string ks && ks.Length == 0) || (sv is int ki && ki < 0))) continue;
                    string? s = null;
                    try { if (conv.CanConvertTo(typeof(string))) s = conv.ConvertToInvariantString(sv); } catch { s = null; }
                    if (!string.IsNullOrEmpty(s) && !vals.Contains(s!)) vals.Add(s!);
                    if (vals.Count >= 256) break; // bound — keep the payload sane for huge converters
                }
                // vals.Count==0 → no dropdown (plain field). For an image converter that means the ImageList is absent/empty
                // (only the sentinel, now filtered) — so a populated 1-image list (even a no-sentinel NoneExcludedImageIndex
                // Converter, which yields exactly [0]) correctly still shows its dropdown (codex: the old <2 gate wrongly hid it).
                if (vals.Count == 0) return (null, false);
                // guard the exclusivity query separately — a converter that enumerates fine but throws here
                // should still yield the (non-exclusive) dropdown rather than discard the whole list.
                bool excl = false;
                try { excl = ctx != null ? conv.GetStandardValuesExclusive(ctx) : conv.GetStandardValuesExclusive(); }
                catch { try { excl = conv.GetStandardValuesExclusive(); } catch { excl = false; } }
                return (vals, excl);
            }
            catch { return (null, false); }
        }

        /// <summary>The "clear the reference" sentinel shown/committed for a component-reference dropdown. A fixed
        /// English token (like the en-canonical enum/color values) — never a real field name (field names are valid
        /// C# identifiers, so they can never collide with the parenthesised token). The host maps it to `null`.</summary>
        public const string ReferenceNone = "(none)";

        /// <summary>The synthetic "the ROOT form itself" option for a component-reference dropdown — the value VS offers
        /// for a reference the form can satisfy (e.g. ErrorProvider.ContainerControl = this). Like <see cref="ReferenceNone"/>
        /// it is a fixed en-canonical parenthesised token that can never collide with a field name (not a valid C#
        /// identifier); the host maps it to a bare `this` splice and net48 resolves it to the live root.</summary>
        public const string ReferenceThis = "(this)";

        /// <summary>For a component-reference property (a framework <see cref="System.ComponentModel.ReferenceConverter"/>
        /// target — Form.AcceptButton/CancelButton, Control.ContextMenuStrip, …), the compatible sibling component
        /// FIELD NAMES + a leading "(none)", plus the CURRENT reference's field name (or "(none)"). The converter can
        /// only list these when handed a design container (a plain runtime instance has none), so we self-enumerate the
        /// container being described — engine-symmetric with the net48 side. Returns null when the property is not a
        /// framework reference target or no compatible sibling exists (→ keep the plain field, no empty dropdown).
        /// Fully guarded — never throws. The candidate names are read from Site.Name (== the field name the write
        /// splices `this.&lt;name&gt;`); current is read from the SAME source so the value pre-selects.</summary>
        private static (List<string> values, string current)? ReferenceValuesOf(PropertyDescriptor pd, IComponent owner,
            object? raw, IReadOnlyList<IComponent> siblings, IComponent? root)
        {
            try
            {
                // Reference dropdowns are for owners edited through the CONTROL channel — a Control OR a tray Component
                // (NotifyIcon.ContextMenuStrip, ErrorProvider.ContainerControl, …), both of which the panel edits by
                // currentId and carries a reference pick through `refEdit`. A ToolStripItem also carries ReferenceConverter
                // props (ToolStripMenuItem.DropDown), but item edits route through the ITEM channel (ownerId), which does
                // NOT translate a reference pick — so offering the dropdown there would half-wire a mis-write. Exclude
                // only items; every other IComponent owner is fair game (the guards below keep the candidate list sound).
                if (owner is ToolStripItem) return null;
                if (pd.PropertyType.IsEnum) return null;
                var conv = pd.Converter;
                if (conv is not System.ComponentModel.ReferenceConverter) return null;
                // Gate on a framework assembly: System.dll defines ReferenceConverter; a WinForms ReferenceConverter
                // subclass lives in System.Windows.Forms.dll. Excludes any third-party ReferenceConverter subclass.
                var asm = conv.GetType().Assembly;
                if (!ReferenceEquals(asm, typeof(System.ComponentModel.ReferenceConverter).Assembly)
                    && !ReferenceEquals(asm, typeof(Control).Assembly)) return null;

                var names = new List<string>();
                foreach (var sib in siblings)
                {
                    if (ReferenceEquals(sib, owner)) continue;             // a component never references itself
                    if (!pd.PropertyType.IsInstanceOfType(sib)) continue;  // only assignable siblings
                    string? n = sib.Site?.Name;
                    if (!string.IsNullOrEmpty(n) && !names.Contains(n!)) names.Add(n!);
                }
                names.Sort(StringComparer.Ordinal);

                // The ROOT form is itself an offered candidate whenever it is assignable to the property — VS lists the
                // form (e.g. ErrorProvider.ContainerControl = this). It carries no field, so it is never a this.<field>
                // sibling; it is represented by the synthetic ReferenceThis token that the write path maps to a bare
                // `this`. Exclude the degenerate case where the OWNER is the root (a component never references itself).
                bool rootAssignable = root != null && !ReferenceEquals(root, owner)
                    && pd.PropertyType.IsInstanceOfType(root);

                string current = ReferenceNone;
                if (raw is IComponent rc && !ReferenceEquals(rc, owner))
                {
                    if (rootAssignable && ReferenceEquals(rc, root)) current = ReferenceThis; // the root form itself
                    else
                    {
                        string? cn = rc.Site?.Name;
                        if (!string.IsNullOrEmpty(cn)) current = cn!;
                    }
                }
                // Offer the dropdown only when there is at least one candidate (a sibling OR the root) AND the CURRENT
                // reference is representable in it (null/"(none)", the root token, or a listed sibling). An out-of-scope
                // component whose name isn't a candidate would misrepresent the value (or write an invalid this.<name>
                // RHS) and diverge from net48 — keep the plain field so the real value is never clobbered (codex review).
                if (names.Count == 0 && !rootAssignable) return null;              // no candidate at all → plain field
                if (raw is IComponent && current == ReferenceNone) return null;    // a live reference we could not name → out of scope
                if (current != ReferenceNone && current != ReferenceThis && !names.Contains(current)) return null;
                var values = new List<string>(names.Count + 2) { ReferenceNone };
                if (rootAssignable) values.Add(ReferenceThis);                     // the form itself, right after "(none)"
                values.AddRange(names);
                return (values, current);
            }
            catch { return null; }
        }

        /// <summary>The converter's standard-values set, PREFERRING the context-aware overload (so ImageIndexConverter /
        /// ImageKeyConverter can resolve the attached ImageList) and FALLING BACK to the context-less form if the context
        /// upsets a converter — strictly non-regressing. Null when neither reports a supported set.</summary>
        private static System.Collections.ICollection? StandardValuesColl(System.ComponentModel.TypeConverter conv, ITypeDescriptorContext? ctx)
        {
            if (ctx != null)
            {
                try { if (conv.GetStandardValuesSupported(ctx)) { var c = conv.GetStandardValues(ctx); if (c != null) return c; } }
                catch { /* the context upset this converter → fall back to the context-less form below */ }
            }
            try { if (conv.GetStandardValuesSupported()) return conv.GetStandardValues(); } catch { /* no standard values */ }
            return null;
        }

        /// <summary>A minimal <see cref="ITypeDescriptorContext"/> for a describe-time TypeConverter query: it carries the
        /// component being described (Instance) and the property (PropertyDescriptor) — enough for ImageIndexConverter /
        /// ImageKeyConverter to read the control's related ImageList. Container / services are best-effort off the site.
        /// Read-only: the change notifications are no-ops (describe never mutates through the converter).</summary>
        private sealed class DescribeContext : ITypeDescriptorContext
        {
            private readonly IComponent _instance;
            private readonly PropertyDescriptor _pd;
            public DescribeContext(IComponent instance, PropertyDescriptor pd) { _instance = instance; _pd = pd; }
            public IContainer? Container { get { try { return _instance.Site?.Container; } catch { return null; } } }
            public object? Instance => _instance;
            public PropertyDescriptor? PropertyDescriptor => _pd;
            public object? GetService(Type serviceType) { try { return _instance.Site?.GetService(serviceType); } catch { return null; } }
            public bool OnComponentChanging() => true;
            public void OnComponentChanged() { }
        }

        /// <summary>The individual single-bit member names of a [Flags] enum (value != 0 and a power of two),
        /// in declaration order — the atomic flags a checkbox dropdown toggles. Null for non-flags / non-enums,
        /// or when the enum exposes no single-bit members. Fully guarded (never throws).</summary>
        private static List<string>? FlagsMembersOf(Type t)
        {
            try
            {
                if (!t.IsEnum || !t.IsDefined(typeof(FlagsAttribute), false)) return null;
                var members = new List<string>();
                foreach (var name in Enum.GetNames(t))
                {
                    // Read the member as its UNSIGNED bit pattern masked to the enum's underlying width, so a
                    // high-bit single flag isn't misclassified as composite: a signed Int64 widening would
                    // sign-extend int 0x80000000 to 0xFFFFFFFF80000000 (fails the power-of-two test), and a
                    // UInt64 member > long.MaxValue would overflow Convert.ToInt64. The per-underlying-type
                    // cast reinterprets the exact width instead.
                    ulong u;
                    try
                    {
                        object uv = Convert.ChangeType(Enum.Parse(t, name), Enum.GetUnderlyingType(t));
                        u = uv switch
                        {
                            byte b => b,
                            sbyte sb => (byte)sb,
                            short s => (ushort)s,
                            ushort us => us,
                            int i => (uint)i,
                            uint ui => ui,
                            long l => (ulong)l,
                            ulong ul => ul,
                            _ => 0UL,
                        };
                    }
                    catch { continue; }
                    if (u == 0) continue;              // skip the zero member (None)
                    if ((u & (u - 1)) != 0) continue;  // skip composite (multi-bit) members
                    members.Add(name);
                }
                return members.Count > 0 ? members : null;
            }
            catch { return null; }
        }

        /// <summary>The name of a [Flags] enum's zero-valued member (e.g. "None"), or null. Lets the checkbox
        /// dropdown commit a valid value when everything is unchecked. Guarded (never throws).</summary>
        private static string? FlagsZeroOf(Type t)
        {
            try
            {
                if (!t.IsEnum || !t.IsDefined(typeof(FlagsAttribute), false)) return null;
                return Enum.GetName(t, Enum.ToObject(t, 0L));
            }
            catch { return null; }
        }

        /// <summary>True when a property's value type is an image/icon (System.Drawing.Image and its subclasses —
        /// Bitmap/Metafile — or System.Drawing.Icon). Drives the grid's preview + Import…/(none) editor.</summary>
        private static bool IsImageProperty(Type t) =>
            typeof(System.Drawing.Image).IsAssignableFrom(t) || t == typeof(System.Drawing.Icon);

        /// <summary>The three WinForms string-item collections VS edits with the "String Collection Editor"
        /// (one item per line): ComboBox/ListBox/CheckedListBox.Items. Matched by their exact property type so
        /// nothing else (typed collections like DataGridView.Columns) is surfaced by this slice.</summary>
        private static readonly HashSet<string> StringCollectionTypeNames = new(StringComparer.Ordinal)
        {
            "System.Windows.Forms.ComboBox+ObjectCollection",
            "System.Windows.Forms.ListBox+ObjectCollection",
            "System.Windows.Forms.CheckedListBox+ObjectCollection",
        };

        private static bool IsStringCollectionProperty(PropertyDescriptor pd) =>
            pd.PropertyType.FullName != null && StringCollectionTypeNames.Contains(pd.PropertyType.FullName);

        /// <summary>Typed collections edited with a per-item property editor (VS "Collection Editor"). This slice
        /// surfaces only ListView.Columns (ColumnHeader items); its property type is matched exactly so no other
        /// collection is affected. The webview branches on <see cref="PropertyInfo.CollectionItemType"/>.</summary>
        private static readonly Dictionary<string, string> TypedCollectionItemTypes = new(StringComparer.Ordinal)
        {
            ["System.Windows.Forms.ListView+ColumnHeaderCollection"] = "System.Windows.Forms.ColumnHeader",
            ["System.Windows.Forms.DataGridViewColumnCollection"] = "System.Windows.Forms.DataGridViewColumn",
            ["System.Windows.Forms.TreeNodeCollection"] = "System.Windows.Forms.TreeNode",
            // MenuStrip/ToolStrip/StatusStrip.Items and ToolStripMenuItem/ToolStripDropDownButton.DropDownItems are
            // all ToolStripItemCollection — one entry surfaces the "…" ToolStrip item editor on every strip and submenu.
            ["System.Windows.Forms.ToolStripItemCollection"] = "System.Windows.Forms.ToolStripItem",
        };

        private static string? TypedCollectionItemType(PropertyDescriptor pd) =>
            pd.PropertyType.FullName != null && TypedCollectionItemTypes.TryGetValue(pd.PropertyType.FullName, out var it) ? it : null;

        private const int ThumbMax = 64;             // preview swatch cap (px); larger sources are scaled down, aspect-preserved
        private const long MaxSrcPixels = 4096L * 4096L; // total-pixel bound on the SOURCE — reject a pixel bomb before DrawImage allocates

        /// <summary>Render an image/icon property's LIVE value to a small base64 PNG thumbnail (≤ <see cref="ThumbMax"/>
        /// px, aspect-preserved), or null when there's no value / it's not an image / it can't be rendered. Draws the
        /// source directly into the thumbnail (no full-size clone) and NEVER disposes the live value — only an
        /// icon-derived temporary bitmap is disposed. Fully guarded: any failure degrades to null (no preview).</summary>
        private static string? TryThumbnail(object? raw)
        {
            try
            {
                System.Drawing.Image? src;
                System.Drawing.Bitmap? icoBmp = null;
                if (raw is System.Drawing.Icon ico) { icoBmp = ico.ToBitmap(); src = icoBmp; }
                else if (raw is System.Drawing.Image img) src = img;
                else return null;
                try
                {
                    int w = src.Width, h = src.Height;
                    // bound the SOURCE dimensions AND total pixels before allocating — a pixel-bomb image already
                    // materialized by the resx reader must not also balloon a full-frame thumbnail draw. The
                    // long-cast product guards against a huge-on-both-axes image slipping past per-axis caps.
                    if (w <= 0 || h <= 0 || w > 20000 || h > 20000 || (long)w * h > MaxSrcPixels) return null;
                    double scale = Math.Min(1.0, Math.Min((double)ThumbMax / w, (double)ThumbMax / h));
                    int tw = Math.Max(1, (int)Math.Round(w * scale));
                    int th = Math.Max(1, (int)Math.Round(h * scale));
                    using var thumb = new System.Drawing.Bitmap(tw, th, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                    using (var g = System.Drawing.Graphics.FromImage(thumb))
                    {
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                        g.DrawImage(src, new System.Drawing.Rectangle(0, 0, tw, th));
                    }
                    using var ms = new System.IO.MemoryStream();
                    thumb.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                    return Convert.ToBase64String(ms.ToArray());
                }
                finally { icoBmp?.Dispose(); } // dispose only the icon-derived temp; never the live `img`
            }
            catch { return null; }
        }

        /// <summary>Invariant string via the property's TypeConverter, or null (no arbitrary ToString fallback).</summary>
        private static string? StringifyInvariant(PropertyDescriptor pd, object? v)
        {
            if (v == null) return null;
            if (pd.Converter is { } conv && conv.CanConvertTo(typeof(string)))
            {
                return conv.ConvertToInvariantString(v);
            }
            return null;
        }
    }
}
