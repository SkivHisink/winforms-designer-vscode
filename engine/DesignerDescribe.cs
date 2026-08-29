using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.Drawing;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Windows.Forms.Design;

namespace WinFormsDesigner.Engine
{
    public sealed class ExpandablePropertyInfo
    {
        public string Name { get; init; } = "";
        public string PropertyPath { get; init; } = "";
        public string Type { get; init; } = "";
        /// <summary>Current value as a bounded invariant string, or null if null / not invariantly convertible.</summary>
        public string? Value { get; init; }
        /// <summary>The nested descriptor's own read-only state. This is metadata only; no nested write route is implied.</summary>
        public bool ReadOnly { get; init; }
        /// <summary>True when the current value is read/write and can be converted by the existing source expression converter.
        /// Metadata only: this does not advertise a nested property write API.</summary>
        public bool SourceEditable { get; init; }
        public string Category { get; init; } = "Misc";
        public string? Description { get; init; }
        public List<string>? StandardValues { get; init; }
        public bool StandardValuesExclusive { get; init; }
        /// <summary>Stable, non-localized diagnostic for converter metadata that could not be obtained safely.</summary>
        public string? MetadataDiagnosticCode { get; init; }
        public List<ExpandablePropertyInfo>? Properties { get; init; }
        public bool PropertiesTruncated { get; init; }
    }

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
        /// <summary>True only for an allowlisted property of an accessible inherited framework control. The
        /// component remains generally read-only; the host must route this row through the token-checked derived
        /// override RPC instead of the ordinary current-source SetProperty path.</summary>
        public bool InheritedOverrideEditable { get; init; }
        /// <summary>True when a canonical source-explicit inherited override may be removed through the token-checked
        /// reset RPC. This remains true for a layout-managed geometry row that is intentionally read-only for writes.</summary>
        public bool InheritedOverrideResettable { get; init; }
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
        /// <summary>Stable, non-localized diagnostic for converter metadata that could not be obtained safely.</summary>
        public string? MetadataDiagnosticCode { get; init; }
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
        /// <summary>True for the first-class DataSource workflow on BindingSource/ListControl/DataGridView.</summary>
        public bool IsDataSource { get; init; }
        /// <summary>Provider field id for an extender pseudo-property, or null for a normal property.</summary>
        public string? ExtenderProvider { get; init; }
        /// <summary>The SetX/GetX method suffix for an extender pseudo-property.</summary>
        public string? ExtenderProperty { get; init; }
        /// <summary>True for a design-time PSEUDO-property (Modifiers / GenerateMember) that is NOT a live component
        /// property — it's a source artifact (a field's access keyword / whether a field exists). The host routes its
        /// edit to the dedicated field-declaration splice, NOT setProperty; distinguishing on this flag (not the name)
        /// keeps a real control property that happens to be named "Modifiers" on the normal edit path.</summary>
        public bool DesignTime { get; init; }
        /// <summary>True when the shared generic IList editor, rather than a bespoke collection editor, owns the route.</summary>
        public bool GenericCollection { get; init; }
        /// <summary>Closed, engine-supported editor type. Framework CollectionEditor is read from an exact
        /// EditorAttribute; arbitrary project EditorAttribute metadata remains non-executable.</summary>
        public string? UiTypeEditor { get; init; }
        public string? UiTypeEditorAssemblyPath { get; init; }
        public string? UiTypeEditorAssemblySha256 { get; init; }
        public string? UiTypeEditorCertificationId { get; init; }
        /// <summary>Bounded TypeConverter-provided nested property metadata for expandable objects. Supplemental
        /// read-side metadata only; existing scalar/collection/image/reference edit routes are unchanged.</summary>
        public List<ExpandablePropertyInfo>? Properties { get; init; }
        public bool PropertiesTruncated { get; init; }
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

    /// <summary>A bounded entry surfaced by the component's real <see cref="DesignerActionList"/>. Ordinary property
    /// items map to <see cref="PropertyName"/> and keep using the established property transaction. The one exact
    /// repository-certified command carries <see cref="CommandId"/> plus <see cref="CertificationId"/> and must be
    /// revalidated by the hosted-service broker before its proposals can enter the source planner.</summary>
    public sealed class DesignerActionInfo
    {
        public string DisplayName { get; init; } = "";
        public string PropertyName { get; init; } = "";
        public string CommandId { get; init; } = "";
        public string CertificationId { get; init; } = "";
        public string Category { get; init; } = "";
        public string? Description { get; init; }
    }

    /// <summary>Fail-closed result of confirming one control-local adorner hover in the live product graph.</summary>
    public sealed class DesignerAdornerHitInfo
    {
        public bool Ok { get; init; }
        public bool Hit { get; init; }
        public string ComponentId { get; init; } = "";
        public string AdornerId { get; init; } = "";
        public string ComponentType { get; init; } = "";
        public string DesignerType { get; init; } = "";
        public string ErrorCode { get; init; } = "";
        public string Reason { get; init; } = "";
    }

    /// <summary>Renderer-supplied identity and source ownership for one live graph component.</summary>
    public sealed class ComponentOwnershipInfo
    {
        public string Id { get; init; } = "";
        public string Name { get; init; } = "";
        public string Ownership { get; init; } = "unresolved";
        public bool Editable { get; init; }
        public string? ReadOnlyReason { get; init; }
        public bool InheritedPropertyOverrideEditable { get; init; }
        public bool InheritedGeometryOverrideEditable { get; init; }
        public string BaseIdentityToken { get; init; } = "";
        public string InheritedFieldType { get; init; } = "";
        public string EffectiveAccessibility { get; init; } = "";
        /// <summary>Live-only type evidence consumed by the inherited source writer; never copied to ComponentInfo.</summary>
        public Type? InheritedResolvedFieldType { get; init; }
    }

    public sealed class ComponentInfo
    {
        /// <summary>Edit id to pass to SetProperty: "this" for the root, Site.Name for other components.</summary>
        public string Id { get; init; } = "";
        /// <summary>Display name: the class name for the root, Site.Name for other components.</summary>
        public string Name { get; init; } = "";
        public string Type { get; init; } = "";
        /// <summary>Source ownership: root, currentSource, inherited, or unresolved.</summary>
        public string Ownership { get; init; } = "unresolved";
        /// <summary>True only when this component is addressable from the current designer source.</summary>
        public bool Editable { get; init; }
        public string? ReadOnlyReason { get; init; }
        /// <summary>A narrow derived-source override capability; structural/component-level editability remains false.</summary>
        public bool InheritedOverrideEditable { get; init; }
        public string BaseIdentityToken { get; init; } = "";
        /// <summary>Parent component display name, or null for the root.</summary>
        public string? Parent { get; init; }
        public bool IsRoot { get; init; }
        /// <summary>The browsable event selected by the component's real <see cref="DefaultEventAttribute"/>, or
        /// null when the component has no safe default-event gesture.</summary>
        public string? DefaultEvent { get; init; }
        public List<PropertyInfo> Properties { get; init; } = new();
        /// <summary>VS-style smart-tag property rows supplied by the live component designer.</summary>
        public List<DesignerActionInfo> DesignerActions { get; init; } = new();
        /// <summary>VS-style control-local adorners supplied by the live component designer.</summary>
        public List<DesignerAdornerInfo> DesignerAdorners { get; init; } = new();
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
            Dictionary<string, Dictionary<string, string>>? eventWirings = null,
            Dictionary<string, DesignerModifiers.FieldMod>? fieldModifiers = null,
            IReadOnlyList<IComponent>? graphComponents = null,
            IReadOnlyDictionary<IComponent, ComponentOwnershipInfo>? ownership = null,
            string? controlAssemblyPath = null)
        {
            var root = host.RootComponent;
            var all = (graphComponents ?? host.Container.Components.Cast<IComponent>().ToList()).Distinct().ToList();
            // Reference-dropdown candidates: every sited component EXCEPT the root form — a field-backed component the
            // write can name as `this.<field>`. The root is `this` (no field), never a `this.<name>` reference target,
            // so exclude it (matches the net48 side, whose FieldNames map holds no root entry).
            var siblings = all.Where(x => !ReferenceEquals(x, root) && OwnershipOf(x, root, rootName, ownership).Editable).ToList();
            var components = all
                .Select(c => BuildComponentInfo(host, c, root, rootName, explicitMembers, eventWirings, siblings, fieldModifiers, ownership, controlAssemblyPath))
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
            Dictionary<string, Dictionary<string, string>>? eventWirings = null,
            Dictionary<string, DesignerModifiers.FieldMod>? fieldModifiers = null,
            IReadOnlyList<IComponent>? graphComponents = null,
            IReadOnlyDictionary<IComponent, ComponentOwnershipInfo>? ownership = null,
            string? controlAssemblyPath = null)
        {
            var root = host.RootComponent;
            var all = (graphComponents ?? host.Container.Components.Cast<IComponent>().ToList()).Distinct().ToList();
            var siblings = all.Where(x => !ReferenceEquals(x, root) && OwnershipOf(x, root, rootName, ownership).Editable).ToList(); // see Describe: root is never a `this.<field>` reference target
            IReadOnlyDictionary<IComponent, ComponentOwnershipInfo>? effectiveOwnership = ownership;
            IComponent? target = (componentId is "this" or "")
                ? root
                : all.FirstOrDefault(c => OwnershipOf(c, root, rootName, ownership).Id == componentId);
            if (target == null && TryResolveSyntheticSplitterPanel(all, root, rootName, componentId, ownership,
                out var panel, out var panelOwnership))
            {
                target = panel;
                var expanded = ownership == null
                    ? new Dictionary<IComponent, ComponentOwnershipInfo>()
                    : ownership.ToDictionary(pair => pair.Key, pair => pair.Value);
                expanded[target] = panelOwnership;
                effectiveOwnership = expanded;
            }
            return target == null ? null : BuildComponentInfo(host, target, root, rootName, explicitMembers, eventWirings, siblings, fieldModifiers, effectiveOwnership, controlAssemblyPath);
        }

        private static bool TryResolveSyntheticSplitterPanel(
            IReadOnlyList<IComponent> all,
            IComponent root,
            string rootName,
            string componentId,
            IReadOnlyDictionary<IComponent, ComponentOwnershipInfo>? ownership,
            out SplitterPanel panel,
            out ComponentOwnershipInfo panelOwnership)
        {
            panel = null!;
            panelOwnership = null!;
            int separator = componentId.LastIndexOf('.');
            if (separator <= 0 || separator == componentId.Length - 1) return false;
            string splitId = componentId.Substring(0, separator);
            string panelName = componentId.Substring(separator + 1);
            if (panelName != "Panel1" && panelName != "Panel2") return false;
            var split = all.OfType<SplitContainer>().FirstOrDefault(candidate =>
                OwnershipOf(candidate, root, rootName, ownership).Id == splitId);
            if (split == null) return false;
            var splitSource = OwnershipOf(split, root, rootName, ownership);
            panel = panelName == "Panel1" ? split.Panel1 : split.Panel2;
            panelOwnership = new ComponentOwnershipInfo
            {
                Id = componentId,
                Name = panelName,
                Ownership = splitSource.Ownership,
                Editable = splitSource.Editable,
                ReadOnlyReason = splitSource.ReadOnlyReason,
                InheritedPropertyOverrideEditable = splitSource.InheritedPropertyOverrideEditable,
                InheritedGeometryOverrideEditable = false,
                BaseIdentityToken = splitSource.BaseIdentityToken,
                InheritedFieldType = splitSource.InheritedFieldType,
                EffectiveAccessibility = splitSource.EffectiveAccessibility,
            };
            return true;
        }

        private static ComponentInfo BuildComponentInfo(IDesignerHost host, IComponent c, IComponent root, string rootName,
            HashSet<(IComponent, string)> explicitMembers,
            Dictionary<string, Dictionary<string, string>>? eventWirings,
            IReadOnlyList<IComponent> siblings,
            Dictionary<string, DesignerModifiers.FieldMod>? fieldModifiers,
            IReadOnlyDictionary<IComponent, ComponentOwnershipInfo>? ownership,
            string? controlAssemblyPath)
        {
            bool isRoot = ReferenceEquals(c, root);
            var source = OwnershipOf(c, root, rootName, ownership);
            string idKey = source.Id;
            Dictionary<string, string>? wired = null;
            eventWirings?.TryGetValue(idKey, out wired);
            var props = DescribeProperties(c, explicitMembers, siblings, root, source.Editable,
                source.InheritedPropertyOverrideEditable, source.InheritedGeometryOverrideEditable, controlAssemblyPath);
            if (source.Editable) InjectDesignTimeProperties(props, c, root, fieldModifiers);
            return new ComponentInfo
            {
                Id = idKey,
                Name = source.Name,
                Type = c.GetType().FullName ?? c.GetType().Name,
                Ownership = source.Ownership,
                Editable = source.Editable,
                ReadOnlyReason = source.ReadOnlyReason,
                InheritedOverrideEditable = source.InheritedPropertyOverrideEditable,
                BaseIdentityToken = source.BaseIdentityToken,
                Parent = ParentName(c, root, rootName, ownership),
                IsRoot = isRoot,
                DefaultEvent = DescribeDefaultEvent(c),
                Properties = props,
                DesignerActions = DescribeDesignerActions(host, c, props, source.Editable),
                DesignerAdorners = DescribeDesignerAdorners(host, c, source.Editable),
                Events = DescribeEvents(c, wired),
            };
        }

        private const int DesignerActionMaxLists = 8;
        private const int DesignerActionMaxItems = 64;
        private const int DesignerActionMaxNameChars = 256;
        private const int DesignerActionMaxCategoryChars = 128;
        private const int DesignerActionMaxDescriptionChars = 1024;

        /// <summary>
        /// Read the product DesignSurface's real ComponentDesigner action lists, but expose only property items that
        /// map to an already-described ordinary editable property. No action-list setter or verb is invoked here;
        /// the webview posts the mapped property through the existing source-first SetProperty transaction.
        /// Third-party designer callbacks are bounded by list/item/string limits and fail closed on any exception.
        /// </summary>
        private static List<DesignerActionInfo> DescribeDesignerActions(
            IDesignerHost host, IComponent component, IReadOnlyList<PropertyInfo> properties, bool componentEditable)
        {
            var result = new List<DesignerActionInfo>();
            if (!componentEditable) return result;

            var safeProperties = new Dictionary<string, PropertyInfo>(StringComparer.Ordinal);
            foreach (var property in properties)
            {
                if (property.ReadOnly || property.DesignTime || property.TableCell || property.IsCollection
                    || property.GenericCollection || property.IsImage || property.IsDataSource
                    || property.ExtenderProvider != null || safeProperties.ContainsKey(property.Name))
                    continue;
                safeProperties[property.Name] = property;
            }
            if (safeProperties.Count == 0) return result;

            ComponentDesigner? designer = null;
            ComponentDesigner? fallbackDesigner = null;
            DesignerActionListCollection? lists = null;
            try
            {
                designer = host.GetDesigner(component) as ComponentDesigner;
                lists = designer?.ActionLists;
            }
            catch { /* a broken host designer may still have a resolvable explicit DesignerAttribute */ }

            // DesignSurface's stock TypeDescriptor.CreateDesigner cannot resolve a DesignerAttribute whose designer
            // lives in the same collectible, byte-loaded user assembly: Type.GetType searches the default ALC. Resolve
            // that exact attribute against the component's own ALC and initialize the designer on the already-sited
            // component. Its Site services are still the product IDesignerHost/change/selection service composition.
            if (lists == null || lists.Count == 0)
            {
                fallbackDesigner = CreateExplicitHostedDesigner(component, designer?.GetType());
                if (fallbackDesigner != null)
                {
                    designer = fallbackDesigner;
                    try { lists = designer.ActionLists; }
                    catch { lists = null; }
                }
            }
            if (designer == null || lists == null)
            {
                fallbackDesigner?.Dispose();
                return result;
            }

            try
            {
                var seen = new HashSet<(string PropertyName, string DisplayName)>();
                var seenCommands = new HashSet<(string CommandId, string DisplayName)>();
                int listCount = 0;
                int itemCount = 0;
                foreach (DesignerActionList list in lists)
                {
                    if (listCount++ >= DesignerActionMaxLists || itemCount >= DesignerActionMaxItems) break;
                    DesignerActionItemCollection items;
                    try { items = list.GetSortedActionItems(); }
                    catch { continue; }
                    if (items == null) continue;

                    foreach (DesignerActionItem item in items)
                    {
                        if (itemCount++ >= DesignerActionMaxItems) break;
                        if (item is DesignerActionMethodItem methodItem)
                        {
                            DesignerActionInfo? command = DescribeCertifiedHostedServiceCommand(
                                component, designer, list, methodItem);
                            if (command != null && seenCommands.Add((command.CommandId, command.DisplayName)))
                                result.Add(command);
                            continue;
                        }
                        if (item is not DesignerActionPropertyItem propertyItem) continue;

                        string memberName;
                        try { memberName = propertyItem.MemberName ?? ""; }
                        catch { continue; }
                        if (memberName.Length == 0) continue;

                        string propertyName = ResolveHostedDesignerPropertyTarget(list, memberName);
                        if (propertyName.Length == 0 || !safeProperties.ContainsKey(propertyName)) continue;

                        string displayName;
                        string category;
                        string? description;
                        try
                        {
                            displayName = BoundDesignerActionString(propertyItem.DisplayName, DesignerActionMaxNameChars);
                            category = BoundDesignerActionString(propertyItem.Category, DesignerActionMaxCategoryChars);
                            description = BoundDesignerActionNullable(propertyItem.Description, DesignerActionMaxDescriptionChars);
                        }
                        catch { continue; }
                        if (displayName.Length == 0) displayName = propertyName;
                        if (!seen.Add((propertyName, displayName))) continue;

                        result.Add(new DesignerActionInfo
                        {
                            DisplayName = displayName,
                            PropertyName = propertyName,
                            Category = category,
                            Description = description,
                        });
                    }
                }
            }
            finally { fallbackDesigner?.Dispose(); }
            return result;
        }

        private static DesignerActionInfo? DescribeCertifiedHostedServiceCommand(
            IComponent component,
            ComponentDesigner designer,
            DesignerActionList list,
            DesignerActionMethodItem item)
        {
            if (!string.Equals(component.GetType().Assembly.GetName().Name, "FakeVendor", StringComparison.Ordinal)
                || !string.Equals(component.GetType().FullName,
                    HostedServiceKernelProductBroker.ComponentTypeName, StringComparison.Ordinal)
                || !string.Equals(designer.GetType().FullName,
                    HostedServiceKernelProductBroker.DesignerTypeName, StringComparison.Ordinal)
                || !string.Equals(list.GetType().FullName,
                    HostedServiceKernelProductBroker.ActionListTypeName, StringComparison.Ordinal))
                return null;
            string memberName;
            try { memberName = item.MemberName ?? ""; }
            catch { return null; }
            bool preset = string.Equals(
                memberName, HostedServiceKernelProductBroker.ActionMemberName, StringComparison.Ordinal);
            bool reentrant = string.Equals(
                memberName, HostedServiceKernelProductBroker.ReentrantActionMemberName, StringComparison.Ordinal);
            if (!preset && !reentrant) return null;
            string commandId = InvokeHostedDesignerStringAdapter(list, "GetHostedDesignerCommandId", memberName);
            string certificationId = InvokeHostedDesignerStringAdapter(
                list, "GetHostedDesignerCommandCertificationId", memberName);
            string expectedCommand = reentrant
                ? HostedServiceKernelProductBroker.ReentrantCommandId
                : HostedServiceKernelProductBroker.CommandId;
            if (!string.Equals(commandId, expectedCommand, StringComparison.Ordinal)
                || !string.Equals(certificationId, HostedServiceKernelProductBroker.CertificationId,
                    StringComparison.Ordinal))
                return null;
            try
            {
                return new DesignerActionInfo
                {
                    DisplayName = BoundDesignerActionString(item.DisplayName, DesignerActionMaxNameChars),
                    CommandId = commandId,
                    CertificationId = certificationId,
                    Category = BoundDesignerActionString(item.Category, DesignerActionMaxCategoryChars),
                    Description = BoundDesignerActionNullable(item.Description, DesignerActionMaxDescriptionChars),
                };
            }
            catch { return null; }
        }

        private static string InvokeHostedDesignerStringAdapter(
            DesignerActionList list, string methodName, string memberName)
        {
            try
            {
                MethodInfo? method = list.GetType().GetMethod(
                    methodName,
                    BindingFlags.Instance | BindingFlags.Public,
                    binder: null,
                    types: new[] { typeof(string) },
                    modifiers: null);
                return method?.ReturnType == typeof(string)
                    ? method.Invoke(list, new object[] { memberName }) as string ?? ""
                    : "";
            }
            catch { return ""; }
        }

        /// <summary>Resolve the same live/fallback ControlDesigner path as action-list metadata and expose only the
        /// fixed hosted-adorner contract. Arbitrary BehaviorService objects never cross the process boundary.</summary>
        private static List<DesignerAdornerInfo> DescribeDesignerAdorners(
            IDesignerHost host, IComponent component, bool componentEditable)
        {
            if (!componentEditable || component is not Control) return new List<DesignerAdornerInfo>();
            var (designer, fallback) = ResolveHostedControlDesigner(host, component);
            if (designer == null) return new List<DesignerAdornerInfo>();
            try { return HostedDesignerAdornerContract.Read(designer); }
            catch { return new List<DesignerAdornerInfo>(); }
            finally { fallback?.Dispose(); }
        }

        /// <summary>Rebuild-time confirmation for a hover emitted by the canvas. Descriptor identity, local bounds, and
        /// the designer callback must all agree; stale/unknown/uneditable requests fail closed.</summary>
        internal static DesignerAdornerHitInfo HitTestDesignerAdorner(
            IDesignerHost host,
            IComponent component,
            string componentId,
            string adornerId,
            int x,
            int y,
            bool componentEditable)
        {
            if (!componentEditable || component is not Control)
            {
                return AdornerHitError(component, componentId, adornerId, "component_read_only",
                    "The component is not editable in the current designer source.");
            }
            if (string.IsNullOrWhiteSpace(adornerId) || adornerId.Length > 128)
            {
                return AdornerHitError(component, componentId, adornerId, "invalid_adorner",
                    "The hosted adorner identity is invalid.");
            }

            var (designer, fallback) = ResolveHostedControlDesigner(host, component);
            if (designer == null)
            {
                return AdornerHitError(component, componentId, adornerId, "designer_unavailable",
                    "No hosted ControlDesigner is available for the component.");
            }
            try
            {
                var matches = HostedDesignerAdornerContract.Read(designer)
                    .Where(candidate => string.Equals(candidate.Id, adornerId, StringComparison.Ordinal))
                    .ToList();
                if (matches.Count != 1)
                {
                    return AdornerHitError(component, componentId, adornerId, "adorner_unavailable",
                        "The hosted adorner is not uniquely available.");
                }
                var adorner = matches[0];
                var point = new Point(x, y);
                var bounds = new Rectangle(adorner.Left, adorner.Top, adorner.Width, adorner.Height);
                bool hit = adorner.HitTestable && bounds.Contains(point)
                    && HostedDesignerAdornerContract.ConfirmsHit(designer, adorner.Id, point);
                return new DesignerAdornerHitInfo
                {
                    Ok = true,
                    Hit = hit,
                    ComponentId = componentId,
                    AdornerId = adorner.Id,
                    ComponentType = component.GetType().FullName ?? component.GetType().Name,
                    DesignerType = designer.GetType().FullName ?? designer.GetType().Name,
                };
            }
            catch (Exception ex)
            {
                return AdornerHitError(component, componentId, adornerId, "designer_failed",
                    "Hosted designer adorner hit-test failed: " + ex.GetType().Name + ".");
            }
            finally { fallback?.Dispose(); }
        }

        private static (ControlDesigner? Designer, ComponentDesigner? Fallback) ResolveHostedControlDesigner(
            IDesignerHost host, IComponent component)
        {
            ControlDesigner? live = null;
            try { live = host.GetDesigner(component) as ControlDesigner; }
            catch { /* an explicit same-ALC designer may still be resolvable */ }

            // A stock fallback ControlDesigner carries no hosted contract. Same-ALC DesignerAttribute resolution is
            // required for byte-loaded project assemblies, exactly as for DesignerActionList metadata above.
            if (live?.GetType().GetMethod("GetHostedDesignerAdorners", BindingFlags.Public | BindingFlags.Instance,
                    binder: null, types: Type.EmptyTypes, modifiers: null) != null
                && ReferenceEquals(
                    AssemblyLoadContext.GetLoadContext(live.GetType().Assembly),
                    AssemblyLoadContext.GetLoadContext(component.GetType().Assembly)))
                return (live, null);

            var fallback = CreateExplicitHostedDesigner(component, live?.GetType());
            return fallback is ControlDesigner controlDesigner
                ? (controlDesigner, fallback)
                : (live, fallback);
        }

        private static DesignerAdornerHitInfo AdornerHitError(
            IComponent component, string componentId, string adornerId, string errorCode, string reason) => new()
        {
            ComponentId = componentId ?? "",
            AdornerId = adornerId ?? "",
            ComponentType = component.GetType().FullName ?? component.GetType().Name,
            ErrorCode = errorCode,
            Reason = reason,
        };

        private static ComponentDesigner? CreateExplicitHostedDesigner(IComponent component, Type? existingDesignerType)
        {
            AttributeCollection attributes;
            try { attributes = TypeDescriptor.GetAttributes(component); }
            catch { return null; }
            foreach (DesignerAttribute attribute in attributes.OfType<DesignerAttribute>())
            {
                Type? designerType = ResolveDesignerTypeInComponentContext(component.GetType().Assembly, attribute.DesignerTypeName);
                if (designerType == null || designerType == existingDesignerType
                    || !typeof(ComponentDesigner).IsAssignableFrom(designerType)) continue;
                try
                {
                    if (Activator.CreateInstance(designerType) is not ComponentDesigner designer) continue;
                    designer.Initialize(component);
                    return designer;
                }
                catch { /* try another applicable DesignerAttribute, if present */ }
            }
            return null;
        }

        private static Type? ResolveDesignerTypeInComponentContext(Assembly componentAssembly, string? designerTypeName)
        {
            if (string.IsNullOrWhiteSpace(designerTypeName)) return null;
            try
            {
                AssemblyLoadContext? context = AssemblyLoadContext.GetLoadContext(componentAssembly);
                return Type.GetType(
                    designerTypeName,
                    assemblyName =>
                    {
                        if (AssemblyName.ReferenceMatchesDefinition(componentAssembly.GetName(), assemblyName))
                            return componentAssembly;
                        return context?.Assemblies.FirstOrDefault(assembly =>
                                   AssemblyName.ReferenceMatchesDefinition(assembly.GetName(), assemblyName))
                            ?? AssemblyLoadContext.Default.Assemblies.FirstOrDefault(assembly =>
                                   AssemblyName.ReferenceMatchesDefinition(assembly.GetName(), assemblyName));
                    },
                    (assembly, typeName, ignoreCase) =>
                        (assembly ?? componentAssembly).GetType(typeName, throwOnError: false, ignoreCase: ignoreCase),
                    throwOnError: false);
            }
            catch { return null; }
        }

        private static string ResolveHostedDesignerPropertyTarget(DesignerActionList list, string memberName)
        {
            string target = memberName;
            try
            {
                MethodInfo? adapter = list.GetType().GetMethod(
                    "GetHostedDesignerPropertyTarget",
                    BindingFlags.Instance | BindingFlags.Public,
                    binder: null,
                    types: new[] { typeof(string) },
                    modifiers: null);
                if (adapter != null && adapter.ReturnType == typeof(string))
                    target = adapter.Invoke(list, new object[] { memberName }) as string ?? "";
            }
            catch { return ""; }
            return target;
        }

        private static string BoundDesignerActionString(string? value, int maxChars)
        {
            if (string.IsNullOrEmpty(value)) return "";
            return value.Length <= maxChars ? value : value.Substring(0, maxChars);
        }

        private static string? BoundDesignerActionNullable(string? value, int maxChars) =>
            string.IsNullOrEmpty(value) ? null : BoundDesignerActionString(value, maxChars);

        private static ComponentOwnershipInfo OwnershipOf(IComponent c, IComponent root, string rootName,
            IReadOnlyDictionary<IComponent, ComponentOwnershipInfo>? ownership)
        {
            if (ownership != null && ownership.TryGetValue(c, out var found)) return found;
            bool isRoot = ReferenceEquals(c, root);
            string id = isRoot ? "this" : (c.Site?.Name ?? "");
            return new ComponentOwnershipInfo
            {
                Id = id,
                Name = isRoot ? rootName : id,
                Ownership = isRoot ? "root" : "currentSource",
                Editable = true,
            };
        }

        /// <summary>Append the design-time "Modifiers" (editable) and "GenerateMember" (read-only) pseudo-properties
        /// for a non-root, field-backed component (VS parity, 0.12.0). These are SOURCE artifacts, not live component
        /// properties: Modifiers is the field's access keyword (edited via a byte-local field-declaration splice, safe
        /// on every form), and GenerateMember is "a field exists" (its toggle is a structural field↔local change that
        /// is NOT round-trip-safe, so it is read-only). The root form ("this" — a class, not a field) is skipped.</summary>
        private static void InjectDesignTimeProperties(List<PropertyInfo> props, IComponent c, IComponent root,
            Dictionary<string, DesignerModifiers.FieldMod>? fieldModifiers)
        {
            if (ReferenceEquals(c, root)) return;
            // A ToolStripItem is described through the SAME DescribeComponent path but edited via the item channel
            // (ownerId), which the host prioritizes over the design-time route — so an injected item "Modifiers" would
            // mis-route to setProperty and splice a non-compiling `item.Modifiers = "..."` (codex F6). Menu-item field
            // modifiers are a follow-up; don't surface the pseudo on items.
            if (c is ToolStripItem) return;
            string name = c.Site?.Name ?? "";
            if (name.Length == 0) return;
            // Don't shadow a REAL browsable property of the same name (a custom control could expose one) — the real
            // property keeps the normal edit path; skip the pseudo entirely to avoid a duplicate/conflicting row (codex F6).
            bool hasRealModifiers = props.Any(p => p.Name == "Modifiers");
            bool hasRealGenerateMember = props.Any(p => p.Name == "GenerateMember");
            bool hasRealDesignName = props.Any(p => p.Name == "(Name)");

            DesignerModifiers.FieldMod fm = default;
            bool hasField = fieldModifiers != null && fieldModifiers.TryGetValue(name, out fm);
            string modifier = hasField ? fm.Display : "Private";
            bool modifierEditable = hasField && fm.Editable;

            if (!hasRealDesignName)
            {
                props.Add(new PropertyInfo
                {
                    Name = "(Name)",
                    Type = "System.String",
                    Value = name,
                    ReadOnly = !hasField,
                    IsEnum = false,
                    Category = "Design",
                    Description = "The generated member name. Renaming is refused when code-behind references the current name.",
                    DesignTime = true,
                });
            }

            if (!hasRealGenerateMember)
            {
                props.Add(new PropertyInfo
                {
                    Name = "GenerateMember",
                    Type = "System.Boolean",
                    Value = hasField ? "true" : "false",
                    ReadOnly = true,
                    IsEnum = false,
                    Category = "Design",
                    Description = "Whether the designer generates a member (field) for this component. Read-only preview — toggling field↔local is not round-trip-safe.",
                    StandardValues = new List<string> { "true", "false" },
                    StandardValuesExclusive = true,
                    DesignTime = true,
                });
            }
            if (!hasRealModifiers)
            {
                props.Add(new PropertyInfo
                {
                    Name = "Modifiers",
                    Type = "System.String",
                    Value = modifier,
                    // editable only for a normal single-declarator field; a multi-declarator field is read-only (a change
                    // would affect its siblings). A no-field component (GenerateMember=false) shows the default read-only.
                    ReadOnly = !modifierEditable,
                    IsEnum = false,
                    Category = "Design",
                    Description = "Indicates the visibility level of the object's generated member (field).",
                    StandardValues = DesignerModifiers.DisplayNames,
                    StandardValuesExclusive = true,
                    DesignTime = true,
                });
            }
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

        private static readonly Dictionary<string, string[]> CommonExtenderProperties = new(StringComparer.Ordinal)
        {
            ["System.Windows.Forms.ToolTip"] = new[] { "ToolTip" },
            ["System.Windows.Forms.ErrorProvider"] = new[] { "Error", "IconAlignment", "IconPadding" },
            ["System.Windows.Forms.HelpProvider"] = new[] { "HelpString", "HelpKeyword", "HelpNavigator", "ShowHelp" },
        };

        /// <summary>Surface common framework extender-provider values as editable source-backed pseudo-properties.</summary>
        private static void InjectExtenderProperties(List<PropertyInfo> list, IComponent target, IReadOnlyList<IComponent> siblings)
        {
            foreach (var provider in siblings)
            {
                string providerType = provider.GetType().FullName ?? "";
                if (!CommonExtenderProperties.TryGetValue(providerType, out var propertyNames)
                    || provider is not IExtenderProvider extender)
                    continue;
                bool canExtend;
                try { canExtend = extender.CanExtend(target); } catch { continue; }
                if (!canExtend) continue;
                string providerId = provider.Site?.Name ?? "";
                if (providerId.Length == 0) continue;

                foreach (string propertyName in propertyNames)
                {
                    try
                    {
                        var getter = provider.GetType().GetMethods()
                            .FirstOrDefault(m => m.Name == "Get" + propertyName && m.GetParameters().Length == 1
                                && m.GetParameters()[0].ParameterType.IsInstanceOfType(target));
                        var setter = provider.GetType().GetMethods()
                            .FirstOrDefault(m => m.Name == "Set" + propertyName && m.GetParameters().Length == 2
                                && m.GetParameters()[0].ParameterType.IsInstanceOfType(target));
                        if (getter == null || setter == null) continue;
                        var valueType = setter.GetParameters()[1].ParameterType;
                        object? raw = getter.Invoke(provider, new object[] { target });
                        string? value = raw == null ? null : valueType.IsEnum
                            ? Enum.GetName(valueType, raw)
                            : Convert.ToString(raw, System.Globalization.CultureInfo.InvariantCulture);
                        string displayName = propertyName + " on " + providerId;
                        list.RemoveAll(x => x.Name == displayName);
                        var standards = valueType.IsEnum ? Enum.GetNames(valueType).ToList()
                            : valueType == typeof(bool) ? new List<string> { "False", "True" }
                            : null;
                        list.Add(new PropertyInfo
                        {
                            Name = displayName,
                            Type = valueType.FullName ?? valueType.Name,
                            Value = value,
                            ReadOnly = false,
                            IsEnum = valueType.IsEnum,
                            Category = "Extenders",
                            Description = propertyName + " value supplied by " + providerId + ".",
                            StandardValues = standards,
                            StandardValuesExclusive = standards != null,
                            ExtenderProvider = providerId,
                            ExtenderProperty = propertyName,
                        });
                    }
                    catch { /* one failing provider value must not abort the grid */ }
                }
            }
        }

        private static string? ParentName(IComponent c, IComponent root, string rootName,
            IReadOnlyDictionary<IComponent, ComponentOwnershipInfo>? ownership)
        {
            if (ReferenceEquals(c, root)) return null;
            if (c is Control ctl && ctl.Parent is Control p)
            {
                return ReferenceEquals(p, root) ? rootName : OwnershipOf(p, root, rootName, ownership).Name;
            }
            return null;
        }

        private static List<PropertyInfo> DescribeProperties(IComponent c, HashSet<(IComponent, string)> explicitMembers,
            IReadOnlyList<IComponent> siblings, IComponent root, bool componentEditable = true,
            bool inheritedOverrideEditable = false, bool inheritedGeometryOverrideEditable = false,
            string? controlAssemblyPath = null)
        {
            var list = new List<PropertyInfo>();
            // a child sited directly in a TableLayoutPanel exposes the panel's Column/Row extender properties; they
            // carry [DesignerSerializationVisibility(Hidden)] (the 3-arg Controls.Add is their serialization), so the
            // Hidden filter below would drop them — surface them anyway and route their edits through SetTableCell.
            bool parentIsTlp = c is Control pctl && pctl.Parent is System.Windows.Forms.TableLayoutPanel;
            foreach (PropertyDescriptor pd in TypeDescriptor.GetProperties(c))
            {
                bool isTableCell = parentIsTlp && (pd.Name == "Column" || pd.Name == "Row");
                bool isDataSource = pd.Name == "DataSource"
                    && (c is BindingSource || c is ListControl || c is DataGridView);
                // string-item collections (ComboBox/ListBox/CheckedListBox.Items) are surfaced for the collection
                // editor even though Items is [Browsable(false)] + Hidden serialization — the grid needs them.
                bool isStringCollection = IsStringCollectionProperty(pd);
                string? typedCollectionItem = TypedCollectionItemType(pd);
                var vis = (DesignerSerializationVisibilityAttribute?)pd.Attributes[typeof(DesignerSerializationVisibilityAttribute)];
                // a generic writable string[] property (flagship: TextBox/RichTextBox.Lines) is surfaced through the
                // SAME "…" editor as the string collections, but marked with the distinct CollectionItemType sentinel
                // "System.String[]" so the host routes it to the string-array RPCs (a single `= new string[]{…}`
                // assignment) rather than the Items.Add/AddRange splicer. Gate on a real setter — a getter-only
                // string[] (computed) would show editable but never apply.
                bool isStringArray = pd.PropertyType.FullName == "System.String[]" && !pd.IsReadOnly;
                string? genericCollectionItem = !isStringCollection && typedCollectionItem == null && !isStringArray
                    && vis?.Visibility == DesignerSerializationVisibility.Content
                    && IsListShape(pd.PropertyType)
                    ? GenericCollectionItemType(pd.PropertyType)
                    : null;
                bool genericCollection = genericCollectionItem != null;
                bool isCollection = isStringCollection || typedCollectionItem != null || isStringArray || genericCollection;
                if (!pd.IsBrowsable && !isTableCell && !isCollection) continue;
                if (vis != null && vis.Visibility == DesignerSerializationVisibility.Hidden && !isTableCell && !isCollection) continue;

                // 0.11.0 minimal (Collection) routing — an editable collection the designer serializes inline
                // (DesignerSerializationVisibility.Content + IList) that we DON'T have a bespoke editor for reaches the
                // grid here (Browsable + not Hidden). Rather than showing its useless ToString (the collection's type
                // name), surface a clean READ-ONLY "(Collection)" entry: VS parity (the property is visible), fail-closed
                // (no edit path = no data-loss / no broken "…"). A dedicated generic list editor is the deferred XL work.
                bool unhandledCollection = !isCollection && !isTableCell
                    && vis != null && vis.Visibility == DesignerSerializationVisibility.Content
                    && IsListShape(pd.PropertyType);

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
                string propertyTypeName = pd.PropertyType.FullName ?? pd.PropertyType.Name;
                bool inheritedPropertySupported = inheritedOverrideEditable
                    && !pd.IsReadOnly && !isTableCell && !isCollection && !unhandledCollection && !isDataSource
                    && DesignerInheritedOverrideEditor.SupportsProperty(pd.Name, propertyTypeName);
                bool inheritedPropertyEditable = inheritedPropertySupported
                    && (!DesignerInheritedOverrideEditor.IsGeometryProperty(pd.Name) || inheritedGeometryOverrideEditable);
                bool readOnly = !(componentEditable || inheritedPropertyEditable)
                    || (!genericCollection && pd.IsReadOnly) || unhandledCollection; // Content lists use their source-first editor despite a getter-only property.
                if (isDataSource && componentEditable) readOnly = false;
                if (raw is System.Drawing.Font font && (font.GdiCharSet != 1 || font.GdiVerticalFont))
                {
                    readOnly = true;
                }
                string? uiTypeEditor = !readOnly && pd.PropertyType == typeof(System.Drawing.Color)
                    ? "System.Drawing.Design.ColorEditor"
                    : !readOnly && pd.PropertyType == typeof(System.Drawing.Font)
                        ? "System.Drawing.Design.FontEditor"
                        : null;
                string? advertisedUiTypeEditor = !readOnly
                    ? AdvertisedUiTypeEditor(pd, c.GetType().Assembly)
                    : null;
                if (uiTypeEditor == null && genericCollection
                    && advertisedUiTypeEditor == DesignerUiTypeEditorPolicy.CollectionEditorTypeName)
                    uiTypeEditor = advertisedUiTypeEditor;
                string? uiTypeEditorAssemblyPath = null;
                string? uiTypeEditorAssemblySha256 = null;
                string? uiTypeEditorCertificationId = null;
                if (!readOnly && uiTypeEditor == null
                    && DesignerUiTypeEditorPolicy.TryDescribeCertifiedVendorEditor(
                        c.GetType(),
                        pd.Name,
                        propertyTypeName,
                        advertisedUiTypeEditor,
                        controlAssemblyPath,
                        out string certifiedEditorType,
                        out string certifiedAssemblyPath,
                        out string certifiedAssemblySha256,
                        out string certifiedCertificationId))
                {
                    uiTypeEditor = certifiedEditorType;
                    uiTypeEditorAssemblyPath = certifiedAssemblyPath;
                    uiTypeEditorAssemblySha256 = certifiedAssemblySha256;
                    uiTypeEditorCertificationId = certifiedCertificationId;
                }

                var (standardValues, stdExclusive, metadataDiagnosticCode) = StandardValuesOf(pd, c);

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

                var expandable = ExpandablePropertiesOf(pd, c, raw, pd.Name,
                    isTableCell || isCollection || unhandledCollection || isImage || referenceValues || isDataSource
                    || inheritedPropertyEditable);

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
                    InheritedOverrideEditable = inheritedPropertyEditable,
                    InheritedOverrideResettable = inheritedPropertySupported,
                    IsEnum = pd.PropertyType.IsEnum,
                    Category = string.IsNullOrEmpty(pd.Category) ? "Misc" : pd.Category,
                    Description = description,
                    StandardValues = standardValues,
                    StandardValuesExclusive = stdExclusive,
                    MetadataDiagnosticCode = metadataDiagnosticCode,
                    FlagsMembers = FlagsMembersOf(pd.PropertyType),
                    FlagsZero = FlagsZeroOf(pd.PropertyType),
                    TableCell = isTableCell,
                    IsImage = isImage,
                    ImagePreview = imagePreview,
                    IsCollection = isCollection,
                    GenericCollection = genericCollection,
                    CollectionItemType = isStringArray ? "System.String[]" : (isStringCollection ? "System.String" : (typedCollectionItem ?? genericCollectionItem)),
                    UiTypeEditor = uiTypeEditor,
                    UiTypeEditorAssemblyPath = uiTypeEditorAssemblyPath,
                    UiTypeEditorAssemblySha256 = uiTypeEditorAssemblySha256,
                    UiTypeEditorCertificationId = uiTypeEditorCertificationId,
                    ReferenceValues = referenceValues,
                    IsDataSource = isDataSource,
                    Properties = expandable.properties,
                    PropertiesTruncated = expandable.truncated,
                });
            }
            if (componentEditable) InjectExtenderProperties(list, c, siblings);
            list.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return list;
        }

        private static string? DescribeDefaultEvent(IComponent c)
        {
            try
            {
                var descriptor = TypeDescriptor.GetDefaultEvent(c);
                return descriptor != null && descriptor.IsBrowsable ? descriptor.Name : null;
            }
            catch
            {
                return null;
            }
        }

        private static string? AdvertisedUiTypeEditor(PropertyDescriptor descriptor, Assembly componentAssembly)
        {
            try
            {
                foreach (Attribute rawAttribute in descriptor.Attributes)
                {
                    string? editorBaseTypeMetadata;
                    string? editorTypeMetadata;
                    if (rawAttribute is EditorAttribute attribute)
                    {
                        editorBaseTypeMetadata = attribute.EditorBaseTypeName;
                        editorTypeMetadata = attribute.EditorTypeName;
                    }
                    else if (rawAttribute.GetType().FullName == typeof(EditorAttribute).FullName)
                    {
                        // Project assemblies can carry ComponentModel metadata through a collectible ALC whose
                        // EditorAttribute identity is not assignable to the engine's compile-time identity. Reflect
                        // only this exact framework attribute name and only its two string metadata properties.
                        Type attributeType = rawAttribute.GetType();
                        editorBaseTypeMetadata = attributeType.GetProperty(nameof(EditorAttribute.EditorBaseTypeName))
                            ?.GetValue(rawAttribute) as string;
                        editorTypeMetadata = attributeType.GetProperty(nameof(EditorAttribute.EditorTypeName))
                            ?.GetValue(rawAttribute) as string;
                    }
                    else
                    {
                        continue;
                    }

                    string baseTypeName = UnqualifiedMetadataTypeName(editorBaseTypeMetadata);
                    if (baseTypeName != "System.Drawing.Design.UITypeEditor") continue;
                    string editorTypeName = UnqualifiedMetadataTypeName(editorTypeMetadata);
                    if (editorTypeName == DesignerUiTypeEditorPolicy.CollectionEditorTypeName)
                        return editorTypeName;
                    Type? editorType = ResolveDesignerTypeInComponentContext(componentAssembly, editorTypeMetadata);
                    Type? baseType = ResolveDesignerTypeInComponentContext(componentAssembly, editorBaseTypeMetadata);
                    if (editorType != null && baseType?.IsAssignableFrom(editorType) == true) return editorType.FullName;
                    // A collectible project ALC can expose the UITypeEditor base through a framework type-forwarder
                    // that Type.GetType cannot resolve back into the component context. Preserve only the unqualified
                    // advertised name here: callers still publish nothing unless the fixed certified-vendor policy
                    // validates the exact component/property/value/editor tuple and assembly path/hash. Arbitrary
                    // EditorAttribute code therefore remains non-executable.
                    if (!string.IsNullOrEmpty(editorTypeName)) return editorTypeName;
                }
            }
            catch { /* unsupported or hostile metadata remains non-executable */ }
            return null;
        }

        private static string UnqualifiedMetadataTypeName(string? assemblyQualifiedName)
        {
            if (string.IsNullOrWhiteSpace(assemblyQualifiedName)) return "";
            int separator = assemblyQualifiedName.IndexOf(',');
            return (separator < 0 ? assemblyQualifiedName : assemblyQualifiedName.Substring(0, separator)).Trim();
        }

        private const int ExpandableMaxDepth = 4;
        private const int ExpandableMaxNodes = 128;
        private const int ExpandableMaxChildrenPerNode = 64;
        private const int ExpandableMaxStandardValues = 64;
        private const int ExpandableMaxNameChars = 128;
        private const int ExpandableMaxTypeChars = 256;
        private const int ExpandableMaxPathChars = 512;
        private const int ExpandableMaxValueChars = 1024;
        private const int ExpandableMaxDescriptionChars = 1024;
        private const int ExpandableMaxCategoryChars = 128;
        private static readonly TimeSpan ConverterQueryTimeout = TimeSpan.FromMilliseconds(200);

        private static (List<ExpandablePropertyInfo>? properties, bool truncated) ExpandablePropertiesOf(
            PropertyDescriptor pd, object owner, object? raw, string path, bool suppressForBespokeEditor)
        {
            if (suppressForBespokeEditor || raw == null) return (null, false);
            var budget = new ExpandableBudget(ExpandableMaxNodes);
            var visited = new HashSet<object>(ReferenceEqualityComparer.Instance);
            bool truncated = false;
            var properties = ExpandablePropertiesOf(pd, owner, raw, path, 0, budget, visited, ref truncated);
            return (properties, truncated);
        }

        private static List<ExpandablePropertyInfo>? ExpandablePropertiesOf(PropertyDescriptor ownerDescriptor, object owner,
            object raw, string path, int depth, ExpandableBudget budget, HashSet<object> visited, ref bool truncated)
        {
            if (depth >= ExpandableMaxDepth) { truncated = true; return null; }
            if (!TryEnterVisited(raw, visited)) return null;
            try
            {
                var conv = SafeConverter(ownerDescriptor);
                if (conv == null) return null;
                var ctx = new DescribeContext(owner, ownerDescriptor);
                if (!ConverterPropertiesSupported(conv, ctx)) return null;
                var childDescriptors = ConverterProperties(conv, ctx, raw);
                if (childDescriptors == null || childDescriptors.Count == 0) return null;

                var result = new List<ExpandablePropertyInfo>();
                int emittedForNode = 0;
                foreach (PropertyDescriptor child in childDescriptors)
                {
                    if (emittedForNode >= ExpandableMaxChildrenPerNode) { truncated = true; break; }
                    if (!budget.TryTake()) { truncated = true; break; }
                    if (!ShouldSurfaceExpandableChild(child)) continue;

                    string childPath = StableBound(JoinPropertyPath(path, child.Name), ExpandableMaxPathChars);
                    object? childRaw = null;
                    try { childRaw = child.GetValue(raw); } catch { childRaw = null; }
                    string? childValue = null;
                    try { childValue = BoundNullable(StringifyInvariant(child, childRaw), ExpandableMaxValueChars); } catch { childValue = null; }

                    bool childReadOnly = true;
                    try { childReadOnly = child.IsReadOnly; } catch { childReadOnly = true; }

                    var (standardValues, stdExclusive, metadataDiagnosticCode) = StandardValuesOf(
                        child, raw, ExpandableMaxStandardValues, ExpandableMaxValueChars);

                    string? description = null;
                    try { description = BoundNullable(string.IsNullOrEmpty(child.Description) ? null : child.Description, ExpandableMaxDescriptionChars); }
                    catch { description = null; }

                    string category = "Misc";
                    try { category = BoundString(string.IsNullOrEmpty(child.Category) ? "Misc" : child.Category, ExpandableMaxCategoryChars); }
                    catch { category = "Misc"; }

                    bool nestedTruncated = false;
                    var nested = childRaw == null
                        ? null
                        : ExpandablePropertiesOf(child, raw, childRaw, childPath, depth + 1, budget, visited, ref nestedTruncated);
                    if (nestedTruncated) truncated = true;

                    result.Add(new ExpandablePropertyInfo
                    {
                        Name = BoundString(child.Name, ExpandableMaxNameChars),
                        PropertyPath = childPath,
                        Type = BoundString(child.PropertyType.FullName ?? child.PropertyType.Name, ExpandableMaxTypeChars),
                        Value = childValue,
                        ReadOnly = childReadOnly,
                        SourceEditable = SourceEditableThroughExistingValueConversion(child.PropertyType, childValue, childReadOnly),
                        Category = category,
                        Description = description,
                        StandardValues = standardValues,
                        StandardValuesExclusive = stdExclusive,
                        MetadataDiagnosticCode = metadataDiagnosticCode,
                        Properties = nested,
                        PropertiesTruncated = nestedTruncated,
                    });
                    emittedForNode++;
                }
                result.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
                return result.Count == 0 ? null : result;
            }
            catch
            {
                return null;
            }
            finally
            {
                ExitVisited(raw, visited);
            }
        }

        private static TypeConverter? SafeConverter(PropertyDescriptor pd)
        {
            try { return pd.Converter; } catch { return null; }
        }

        private static bool ConverterPropertiesSupported(TypeConverter conv, ITypeDescriptorContext ctx)
        {
            if (TryRunConverterQuery(() => conv.GetPropertiesSupported(ctx), out bool supported)) return supported;
            return TryRunConverterQuery(() => conv.GetPropertiesSupported(), out supported) && supported;
        }

        private static PropertyDescriptorCollection? ConverterProperties(TypeConverter conv, ITypeDescriptorContext ctx, object value)
        {
            if (TryRunConverterQuery(() => conv.GetProperties(ctx, value, Array.Empty<Attribute>()), out PropertyDescriptorCollection? descriptors))
                return descriptors;
            return TryRunConverterQuery(() => conv.GetProperties(value), out descriptors) ? descriptors : null;
        }

        private static bool ShouldSurfaceExpandableChild(PropertyDescriptor pd)
        {
            try { if (!pd.IsBrowsable) return false; } catch { return false; }
            try
            {
                var vis = (DesignerSerializationVisibilityAttribute?)pd.Attributes[typeof(DesignerSerializationVisibilityAttribute)];
                if (vis != null && vis.Visibility == DesignerSerializationVisibility.Hidden) return false;
            }
            catch { return false; }
            return true;
        }

        private static bool SourceEditableThroughExistingValueConversion(Type type, string? value, bool readOnly)
        {
            if (readOnly || string.IsNullOrEmpty(value)) return false;
            try { return DesignerValueConverter.ToExpression(type.FullName ?? type.Name, value) != null; }
            catch { return false; }
        }

        private static bool TryEnterVisited(object value, HashSet<object> visited)
        {
            Type t;
            try { t = value.GetType(); } catch { return false; }
            if (t.IsValueType) return true;
            return visited.Add(value);
        }

        private static void ExitVisited(object value, HashSet<object> visited)
        {
            try { if (!value.GetType().IsValueType) visited.Remove(value); } catch { /* ignore */ }
        }

        private static string JoinPropertyPath(string parent, string child) =>
            string.IsNullOrEmpty(parent) ? child : parent + "." + child;

        private static string BoundString(string value, int maxChars)
        {
            if (value.Length <= maxChars) return value;
            if (maxChars <= 17) return value.Substring(0, maxChars);
            return value.Substring(0, maxChars - 17) + "~" + StableHash64(value).ToString("x16", System.Globalization.CultureInfo.InvariantCulture);
        }

        private static string StableBound(string value, int maxChars) => BoundString(value, maxChars);

        private static string? BoundNullable(string? value, int maxChars) => value == null ? null : BoundString(value, maxChars);

        private static ulong StableHash64(string value)
        {
            const ulong offset = 14695981039346656037UL;
            const ulong prime = 1099511628211UL;
            ulong hash = offset;
            foreach (char ch in value)
            {
                hash ^= ch;
                hash *= prime;
            }
            return hash;
        }

        private sealed class ExpandableBudget
        {
            private int _remaining;
            public ExpandableBudget(int remaining) { _remaining = remaining; }
            public bool TryTake()
            {
                if (_remaining <= 0) return false;
                _remaining--;
                return true;
            }
        }

        private sealed class ReferenceEqualityComparer : IEqualityComparer<object>
        {
            public static readonly ReferenceEqualityComparer Instance = new();
            public new bool Equals(object? x, object? y) => ReferenceEquals(x, y);
            public int GetHashCode(object obj) => RuntimeHelpers.GetHashCode(obj);
        }

        /// <summary>The property's TypeConverter standard values as invariant strings + whether the set is
        /// exclusive (closed). Returns (null, false) when none are offered, the type is a flags enum (a
        /// single-select can't express combined flags), or any value fails to stringify. Bounded and fully
        /// guarded — a hostile converter degrades to no dropdown, never throws.</summary>
        private static (List<string>?, bool, string?) StandardValuesOf(PropertyDescriptor pd, object owner) =>
            StandardValuesOf(pd, owner, 256, 0);

        private static (List<string>?, bool, string?) StandardValuesOf(
            PropertyDescriptor pd, object owner, int maxValues, int maxValueChars)
        {
            try
            {
                if (pd.PropertyType.IsEnum && pd.PropertyType.IsDefined(typeof(FlagsAttribute), false))
                    return (null, false, null);
                var conv = pd.Converter;
                if (conv == null) return (null, false, null);
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
                var coll = StandardValuesColl(conv, ctx, out string? metadataDiagnosticCode);
                if (coll == null) return (null, false, metadataDiagnosticCode);
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
                    if (!string.IsNullOrEmpty(s))
                    {
                        if (maxValueChars > 0) s = BoundString(s!, maxValueChars);
                        if (!vals.Contains(s!)) vals.Add(s!);
                    }
                    if (vals.Count >= maxValues) break; // bound — keep the payload sane for huge converters
                }
                // vals.Count==0 → no dropdown (plain field). For an image converter that means the ImageList is absent/empty
                // (only the sentinel, now filtered) — so a populated 1-image list (even a no-sentinel NoneExcludedImageIndex
                // Converter, which yields exactly [0]) correctly still shows its dropdown (codex: the old <2 gate wrongly hid it).
                if (vals.Count == 0) return (null, false, metadataDiagnosticCode);
                // guard the exclusivity query separately — a converter that enumerates fine but throws here
                // should still yield the (non-exclusive) dropdown rather than discard the whole list.
                bool excl = false;
                try { excl = ctx != null ? conv.GetStandardValuesExclusive(ctx) : conv.GetStandardValuesExclusive(); }
                catch { try { excl = conv.GetStandardValuesExclusive(); } catch { excl = false; } }
                return (vals, excl, metadataDiagnosticCode);
            }
            catch { return (null, false, null); }
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
        private static System.Collections.ICollection? StandardValuesColl(
            System.ComponentModel.TypeConverter conv,
            ITypeDescriptorContext? ctx,
            out string? metadataDiagnosticCode)
        {
            metadataDiagnosticCode = null;
            if (ctx != null)
            {
                bool supportedQuery = TryRunConverterQuery(
                    () => conv.GetStandardValuesSupported(ctx), out bool supported, out bool supportedTimedOut);
                if (supportedTimedOut)
                {
                    metadataDiagnosticCode = "CONVERTER_TIMEOUT";
                    return null;
                }
                System.Collections.ICollection? c = null;
                bool valuesTimedOut = false;
                bool valuesQuery = supportedQuery && supported
                    && TryRunConverterQuery<System.Collections.ICollection?>(
                        () => conv.GetStandardValues(ctx), out c, out valuesTimedOut);
                if (valuesTimedOut)
                {
                    metadataDiagnosticCode = "CONVERTER_TIMEOUT";
                    return null;
                }
                if (valuesQuery
                    && c != null)
                {
                    return c;
                }
            }
            bool contextlessSupportedQuery = TryRunConverterQuery(
                () => conv.GetStandardValuesSupported(), out bool contextlessSupported, out bool contextlessSupportedTimedOut);
            if (contextlessSupportedTimedOut)
            {
                metadataDiagnosticCode = "CONVERTER_TIMEOUT";
                return null;
            }
            System.Collections.ICollection? values = null;
            bool contextlessValuesTimedOut = false;
            bool contextlessValuesQuery = contextlessSupportedQuery && contextlessSupported
                && TryRunConverterQuery<System.Collections.ICollection?>(
                    () => conv.GetStandardValues(), out values, out contextlessValuesTimedOut);
            if (contextlessValuesTimedOut)
            {
                metadataDiagnosticCode = "CONVERTER_TIMEOUT";
                return null;
            }
            if (contextlessValuesQuery
                && values != null)
            {
                return values;
            }
            return null;
        }

        /// <summary>A minimal <see cref="ITypeDescriptorContext"/> for a describe-time TypeConverter query: it carries the
        /// component being described (Instance) and the property (PropertyDescriptor) — enough for ImageIndexConverter /
        /// ImageKeyConverter to read the control's related ImageList. Container / services are best-effort off the site.
        /// Read-only: the change notifications are no-ops (describe never mutates through the converter).</summary>
        private sealed class DescribeContext : ITypeDescriptorContext
        {
            private readonly object _instance;
            private readonly PropertyDescriptor _pd;
            public DescribeContext(object instance, PropertyDescriptor pd) { _instance = instance; _pd = pd; }
            public IContainer? Container { get { try { return (_instance as IComponent)?.Site?.Container; } catch { return null; } } }
            public object? Instance => _instance;
            public PropertyDescriptor? PropertyDescriptor => _pd;
            public object? GetService(Type serviceType) { try { return (_instance as IComponent)?.Site?.GetService(serviceType); } catch { return null; } }
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

        /// <summary>Typed collections edited with a bounded per-item property editor (VS "Collection Editor"). Exact
        /// framework collection types select the matching editor; all other collections remain on their existing
        /// generic/read-only path. The webview branches on <see cref="PropertyInfo.CollectionItemType"/>.</summary>
        private static readonly Dictionary<string, string> TypedCollectionItemTypes = new(StringComparer.Ordinal)
        {
            ["System.Windows.Forms.ListView+ColumnHeaderCollection"] = "System.Windows.Forms.ColumnHeader",
            ["System.Windows.Forms.DataGridViewColumnCollection"] = "System.Windows.Forms.DataGridViewColumn",
            ["System.Windows.Forms.TreeNodeCollection"] = "System.Windows.Forms.TreeNode",
            ["System.Windows.Forms.TabControl+TabPageCollection"] = "System.Windows.Forms.TabPage",
            ["System.Windows.Forms.ControlBindingsCollection"] = "System.Windows.Forms.Binding",
            // MenuStrip/ToolStrip/StatusStrip.Items and ToolStripMenuItem/ToolStripDropDownButton.DropDownItems are
            // all ToolStripItemCollection — one entry surfaces the "…" ToolStrip item editor on every strip and submenu.
            ["System.Windows.Forms.ToolStripItemCollection"] = "System.Windows.Forms.ToolStripItem",
        };

        private static string? TypedCollectionItemType(PropertyDescriptor pd) =>
            pd.PropertyType.FullName != null && TypedCollectionItemTypes.TryGetValue(pd.PropertyType.FullName, out var it) ? it : null;

        /// <summary>Resolve one unambiguous generic-list item type without instantiating the collection or invoking
        /// vendor metadata. A single IList&lt;T&gt; wins; legacy IList shapes may instead expose one exact public Add(T).
        /// The shared source editor's allowlist is the final capability gate.</summary>
        private static string? GenericCollectionItemType(Type collectionType)
        {
            try
            {
                var interfaceItems = new HashSet<Type>();
                if (collectionType.IsGenericType && collectionType.GetGenericTypeDefinition() == typeof(IList<>))
                    interfaceItems.Add(collectionType.GetGenericArguments()[0]);
                foreach (var iface in collectionType.GetInterfaces())
                    if (iface.IsGenericType && iface.GetGenericTypeDefinition() == typeof(IList<>))
                        interfaceItems.Add(iface.GetGenericArguments()[0]);
                if (interfaceItems.Count > 1) return null;

                Type? itemType = interfaceItems.SingleOrDefault();
                if (itemType == null)
                {
                    var addTypes = collectionType.GetMethods(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
                        .Where(m => m.Name == "Add" && !m.IsGenericMethodDefinition)
                        .Select(m => m.GetParameters())
                        .Where(p => p.Length == 1 && !p[0].ParameterType.IsByRef)
                        .Select(p => p[0].ParameterType)
                        .Distinct()
                        .ToList();
                    if (addTypes.Count != 1) return null;
                    itemType = addTypes[0];
                }

                string? name = itemType.FullName;
                return name != null && DesignerGenericListEditor.SupportsItemType(name) ? name : null;
            }
            catch { return null; }
        }

        private static bool IsListShape(Type type)
        {
            try
            {
                if (typeof(System.Collections.IList).IsAssignableFrom(type)) return true;
                if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IList<>)) return true;
                return type.GetInterfaces().Any(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IList<>));
            }
            catch { return false; }
        }

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
            if (pd.Converter is { } conv
                && TryRunConverterQuery(() => conv.CanConvertTo(typeof(string)), out bool canConvert)
                && canConvert
                && TryRunConverterQuery(() => conv.ConvertToInvariantString(v), out string? converted))
            {
                return converted;
            }
            return null;
        }

        private static bool TryRunConverterQuery<T>(Func<T> query, out T? result)
        {
            return TryRunConverterQuery(query, out result, out _);
        }

        private static bool TryRunConverterQuery<T>(Func<T> query, out T? result, out bool timedOut)
        {
            timedOut = false;
            result = default;

            T? captured = default;
            bool produced = false;
            bool completed;

            lock (PumpGate)
            {
                ConverterQueryPump pump;
                try
                {
                    SharedPump ??= new ConverterQueryPump();
                    pump = SharedPump;
                }
                catch
                {
                    // No thread to run the query on. Degrade this one field rather than run the converter unbounded.
                    return false;
                }

                try
                {
                    completed = pump.Run(
                        () => { try { captured = query(); produced = true; } catch { produced = false; } },
                        ConverterQueryTimeout);
                }
                catch
                {
                    SharedPump = null;
                    return false;
                }

                if (!completed)
                {
                    // The worker is parked inside the converter and will never come back. Drop it and let the next
                    // query start a fresh one — the queries that follow must not inherit this converter's stall.
                    SharedPump = null;
                    timedOut = true;
                    return false;
                }
            }

            if (!produced) return false;
            result = captured;
            return true;
        }

        private static readonly object PumpGate = new();
        private static ConverterQueryPump? SharedPump;

        /// <summary>
        /// A private worker thread that runs third-party converter queries under <see cref="ConverterQueryTimeout"/>.
        /// It deliberately does NOT use the thread pool — see the matching type in engine-net48/CompiledDescriber.cs:
        /// a stalled converter parks its thread for good, .NET injects replacement pool threads slowly, and the next
        /// query then spends its whole budget queued without running a single instruction, costing a property its
        /// VALUE rather than just its dropdown. One worker serves every query of a describe.
        /// </summary>
        private sealed class ConverterQueryPump
        {
            // Never disposed: an abandoned query still signals from its own thread long after we have returned, and
            // signalling a disposed instance would throw there.
            private readonly System.Threading.SemaphoreSlim _pending = new(0, 1);
            private readonly System.Threading.ManualResetEventSlim _finished = new(false);
            private Action _job = static delegate { };

            internal ConverterQueryPump()
            {
                var thread = new System.Threading.Thread(Loop)
                {
                    IsBackground = true, // a parked converter must never keep the engine alive
                    Name = "designer-converter-query",
                };
                thread.Start();
            }

            /// <summary>Runs <paramref name="job"/> on the worker and reports whether it finished in time. A pump
            /// that reports false is stuck inside the converter and must be discarded, never reused.</summary>
            internal bool Run(Action job, TimeSpan timeout)
            {
                _job = job;
                _finished.Reset();
                _pending.Release();
                return _finished.Wait(timeout);
            }

            private void Loop()
            {
                while (true)
                {
                    _pending.Wait();
                    try { _job(); }
                    catch { }
                    finally { _finished.Set(); }
                }
            }
        }
    }
}
