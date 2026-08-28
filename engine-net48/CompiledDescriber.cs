using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design.Serialization;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Property-grid + events data for one control of the LIVE compiled instance, via TypeDescriptor — the net48
    /// analogue of the net9 engine's DesignerDescribe, but reading a real runtime component (not a design-surface
    /// one) and emitting the [Serializable] net48 DTOs (they cross the child-AppDomain boundary). The extraction
    /// logic (standard values, flags enums, image thumbnails, invariant stringify) mirrors DesignerDescribe so the
    /// grid behaves identically. SourceExplicit ("set in source" bold) and event Handler are the ONLY facts this
    /// live-instance read can't see — they need the .Designer.cs assignment/wiring set, filled in the host domain by
    /// <see cref="SourceMetadata.Apply"/> (Roslyn) after this describe returns.
    /// </summary>
    public static class CompiledDescriber
    {
        public static ComponentDesc Describe(IComponent target, string id, string name, bool isRoot, string? parent,
            IReadOnlyList<KeyValuePair<string, IComponent>>? siblings = null, IComponent? root = null)
        {
            return new ComponentDesc
            {
                Id = id,
                Name = name,
                Type = target.GetType().FullName ?? target.GetType().Name,
                Parent = parent,
                IsRoot = isRoot,
                DefaultEvent = DescribeDefaultEvent(target),
                IsToolStripItem = target is ToolStripItem,
                Properties = DescribeProperties(target, siblings ?? System.Array.Empty<KeyValuePair<string, IComponent>>(), root),
                Events = DescribeEvents(target),
            };
        }

        private static List<EventDesc> DescribeEvents(IComponent c)
        {
            var list = new List<EventDesc>();
            foreach (EventDescriptor ed in TypeDescriptor.GetEvents(c))
            {
                if (!ed.IsBrowsable) continue;
                list.Add(new EventDesc
                {
                    Name = ed.Name,
                    Type = ed.EventType.FullName ?? ed.EventType.Name,
                    Category = string.IsNullOrEmpty(ed.Category) ? "Misc" : ed.Category,
                    Handler = null, // wired-handler parse from .Designer.cs is a later refinement
                });
            }
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

        private static List<PropertyDesc> DescribeProperties(IComponent c,
            IReadOnlyList<KeyValuePair<string, IComponent>> siblings, IComponent? root)
        {
            var list = new List<PropertyDesc>();
            bool parentIsTlp = c is Control pctl && pctl.Parent is TableLayoutPanel;
            foreach (PropertyDescriptor pd in TypeDescriptor.GetProperties(c))
            {
                bool isTableCell = parentIsTlp && (pd.Name == "Column" || pd.Name == "Row");
                bool isDataSource = pd.Name == "DataSource"
                    && (c is BindingSource || c is ListControl || c is DataGridView);
                // string-item collections (ComboBox/ListBox/CheckedListBox.Items) + typed collections (ListView.Columns,
                // DataGridView.Columns) are surfaced for the VS "…" collection editor even though they're [Browsable(false)]
                // / Hidden-serialization — the read/write routes to the net9 pure-text engine. Matched by exact
                // property-type name so no other collection is affected (parity with net9's DescribeProperties).
                bool isStringCollection = IsStringCollectionProperty(pd);
                string? typedCollectionItem = TypedCollectionItemType(pd);
                // a generic writable string[] property (TextBox/RichTextBox.Lines) — surfaced through the same "…"
                // editor as the string collections, marked with the distinct "System.String[]" sentinel so the host
                // routes it to the string-array RPCs (single `= new string[]{…}` assignment). Byte-identical marker to
                // net9's DescribeProperties. Gate on a real setter so a getter-only string[] doesn't show editable.
                bool isStringArray = pd.PropertyType == typeof(string[]) && !pd.IsReadOnly;
                bool isCollection = isStringCollection || typedCollectionItem != null || isStringArray;
                if (!pd.IsBrowsable && !isTableCell && !isCollection) continue;
                var vis = (DesignerSerializationVisibilityAttribute?)pd.Attributes[typeof(DesignerSerializationVisibilityAttribute)];
                if (vis != null && vis.Visibility == DesignerSerializationVisibility.Hidden && !isTableCell && !isCollection) continue;

                // 0.11.0 minimal (Collection) routing — mirror the net9 describe: an unhandled inline-serialized IList
                // collection is shown as a READ-ONLY "(Collection)" (VS parity, fail-closed) instead of its ToString.
                bool unhandledCollection = !isCollection && !isTableCell
                    && vis != null && vis.Visibility == DesignerSerializationVisibility.Content
                    && typeof(System.Collections.IList).IsAssignableFrom(pd.PropertyType);

                object? raw = null;
                try { raw = pd.GetValue(c); } catch { raw = null; }

                string? value = null;
                try { value = StringifyInvariant(pd, raw); } catch { value = null; }

                bool? isDefault = null;
                try { isDefault = !pd.ShouldSerializeValue(c); } catch { isDefault = null; }

                // A Font carrying a non-default charset would lose it through the invariant string form — show read-only.
                bool readOnly = pd.IsReadOnly || unhandledCollection; // an unhandled collection has no edit path → read-only
                if (isDataSource) readOnly = false;
                if (raw is System.Drawing.Font font && (font.GdiCharSet != 1 || font.GdiVerticalFont))
                {
                    readOnly = true;
                }

                var (standardValues, stdExclusive, metadataDiagnosticCode) = StandardValuesOf(pd, c);

                // Component-reference property (ReferenceConverter: AcceptButton/CancelButton/ContextMenuStrip…): the
                // compiled instance is not sited, so its converter can't list siblings — self-enumerate the field-backed
                // components (name pairs from the FieldNames map). Overrides value with the referenced field name (the
                // converter's ToString on a non-sited instance would be junk) so the current value pre-selects. Parity
                // with net9's DesignerDescribe.ReferenceValuesOf.
                bool referenceValues = false;
                var refInfo = ReferenceValuesOf(pd, c, raw, siblings, root);
                if (refInfo != null)
                {
                    standardValues = refInfo.Value.values;
                    stdExclusive = true;
                    referenceValues = true;
                    value = refInfo.Value.current;
                }

                // Cursor: only a STANDARD cursor round-trips through the picker; a custom/resx/.cur cursor would be
                // silently replaced on edit. Mirror the Font-charset guard — read-only unless the value is a standard
                // cursor name. (Parity with net9's DescribeProperties.)
                if (pd.PropertyType.FullName == "System.Windows.Forms.Cursor"
                    && (standardValues == null || value == null || !standardValues.Contains(value)))
                {
                    readOnly = true;
                }

                bool isImage = IsImageProperty(pd.PropertyType);
                string? imagePreview = isImage ? TryThumbnail(raw) : null;

                // guarded like the value reads above — a third-party PropertyDescriptor's Description getter can throw;
                // degrade this one field to null rather than aborting the whole grid. (Parity with net9.)
                string? description = null;
                try { description = string.IsNullOrEmpty(pd.Description) ? null : pd.Description; } catch { description = null; }

                list.Add(new PropertyDesc
                {
                    Name = pd.Name,
                    Type = pd.PropertyType.FullName ?? pd.PropertyType.Name,
                    // a collection's live value isn't a literal — the "…" editor drives it, so leave Value null (parity with
                    // net9); an unhandled (read-only) collection shows the clean "(Collection)" placeholder.
                    Value = isCollection ? null : (unhandledCollection ? "(Collection)" : value),
                    IsDefault = isDefault,
                    SourceExplicit = false,
                    ReadOnly = readOnly,
                    IsEnum = pd.PropertyType.IsEnum,
                    Category = string.IsNullOrEmpty(pd.Category) ? "Misc" : pd.Category,
                    StandardValues = standardValues,
                    StandardValuesExclusive = stdExclusive,
                    MetadataDiagnosticCode = metadataDiagnosticCode,
                    FlagsMembers = FlagsMembersOf(pd.PropertyType),
                    FlagsZero = FlagsZeroOf(pd.PropertyType),
                    TableCell = isTableCell,
                    IsImage = isImage,
                    ImagePreview = imagePreview,
                    Description = description,
                    IsCollection = isCollection,
                    CollectionItemType = isStringArray ? "System.String[]" : (isStringCollection ? "System.String" : typedCollectionItem),
                    ReferenceValues = referenceValues,
                    IsDataSource = isDataSource,
                });
            }
            InjectExtenderProperties(list, c, siblings);
            list.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
            return list;
        }

        private static readonly Dictionary<string, string[]> CommonExtenderProperties = new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            { "System.Windows.Forms.ToolTip", new[] { "ToolTip" } },
            { "System.Windows.Forms.ErrorProvider", new[] { "Error", "IconAlignment", "IconPadding" } },
            { "System.Windows.Forms.HelpProvider", new[] { "HelpString", "HelpKeyword", "HelpNavigator", "ShowHelp" } },
        };

        private static void InjectExtenderProperties(List<PropertyDesc> list, IComponent target,
            IReadOnlyList<KeyValuePair<string, IComponent>> siblings)
        {
            foreach (var pair in siblings)
            {
                var provider = pair.Value;
                string providerType = provider.GetType().FullName ?? "";
                if (!CommonExtenderProperties.TryGetValue(providerType, out var propertyNames)
                    || !(provider is IExtenderProvider extender))
                    continue;
                bool canExtend;
                try { canExtend = extender.CanExtend(target); } catch { continue; }
                if (!canExtend || string.IsNullOrEmpty(pair.Key)) continue;

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
                        string displayName = propertyName + " on " + pair.Key;
                        list.RemoveAll(x => x.Name == displayName);
                        var standards = valueType.IsEnum ? Enum.GetNames(valueType).ToList()
                            : valueType == typeof(bool) ? new List<string> { "False", "True" }
                            : null;
                        list.Add(new PropertyDesc
                        {
                            Name = displayName,
                            Type = valueType.FullName ?? valueType.Name,
                            Value = value,
                            ReadOnly = false,
                            IsEnum = valueType.IsEnum,
                            Category = "Extenders",
                            Description = propertyName + " value supplied by " + pair.Key + ".",
                            StandardValues = standards,
                            StandardValuesExclusive = standards != null,
                            ExtenderProvider = pair.Key,
                            ExtenderProperty = propertyName,
                        });
                    }
                    catch { }
                }
            }
        }

        // ---- collection detection (parity with net9 DesignerDescribe): match the property TYPE by exact FullName so
        // only the intended collections are surfaced for the "…" editor; everything else is unaffected. ----
        private static readonly HashSet<string> StringCollectionTypeNames = new HashSet<string>(StringComparer.Ordinal)
        {
            "System.Windows.Forms.ComboBox+ObjectCollection",
            "System.Windows.Forms.ListBox+ObjectCollection",
            "System.Windows.Forms.CheckedListBox+ObjectCollection",
        };
        private static readonly Dictionary<string, string> TypedCollectionItemTypes = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "System.Windows.Forms.ListView+ColumnHeaderCollection", "System.Windows.Forms.ColumnHeader" },
            { "System.Windows.Forms.DataGridViewColumnCollection", "System.Windows.Forms.DataGridViewColumn" },
            { "System.Windows.Forms.TreeNodeCollection", "System.Windows.Forms.TreeNode" },
            { "System.Windows.Forms.ControlBindingsCollection", "System.Windows.Forms.Binding" },
            // MenuStrip/ToolStrip.Items + ToolStripMenuItem.DropDownItems (all ToolStripItemCollection) — parity with net9.
            { "System.Windows.Forms.ToolStripItemCollection", "System.Windows.Forms.ToolStripItem" },
        };
        private static bool IsStringCollectionProperty(PropertyDescriptor pd) =>
            pd.PropertyType.FullName != null && StringCollectionTypeNames.Contains(pd.PropertyType.FullName);
        private static string? TypedCollectionItemType(PropertyDescriptor pd) =>
            pd.PropertyType.FullName != null && TypedCollectionItemTypes.TryGetValue(pd.PropertyType.FullName, out var it) ? it : null;

        /// <summary>The "clear the reference" sentinel for a component-reference dropdown — a fixed English token (en-
        /// canonical, like enum/color values), never a real field name. Byte-identical to net9's DesignerDescribe.ReferenceNone.</summary>
        public const string ReferenceNone = "(none)";

        /// <summary>The synthetic "the ROOT form itself" option for a component-reference dropdown (VS offers the form for
        /// a reference it can satisfy — ErrorProvider.ContainerControl = this). A fixed en-canonical parenthesised token
        /// that can never collide with a field name; the host maps it to a bare `this` and the live write resolves it to
        /// the root. Byte-identical to net9's DesignerDescribe.ReferenceThis.</summary>
        public const string ReferenceThis = "(this)";

        /// <summary>For a component-reference property (a framework <see cref="ReferenceConverter"/> target —
        /// AcceptButton/CancelButton/ContextMenuStrip…), the compatible sibling FIELD NAMES + a leading "(none)" + the
        /// synthetic "(this)" when the root form is assignable, plus the CURRENT reference (its field name, "(none)", or
        /// "(this)" for the root). Self-enumerates the field-backed components (name pairs) because the non-sited compiled
        /// instance's converter can't list them and Site.Name is null. Returns null when the property is not a framework
        /// reference target or no compatible candidate exists. Fully guarded. Parity with net9's ReferenceValuesOf.</summary>
        private static (List<string> values, string current)? ReferenceValuesOf(PropertyDescriptor pd, IComponent owner,
            object? raw, IReadOnlyList<KeyValuePair<string, IComponent>> siblings, IComponent? root)
        {
            try
            {
                // Reference dropdowns are for owners edited through the CONTROL channel — a Control OR a tray Component
                // (NotifyIcon.ContextMenuStrip, ErrorProvider.ContainerControl, …). A ToolStripItem's ReferenceConverter
                // props (ToolStripMenuItem.DropDown) route through the ITEM channel (ownerId), which doesn't translate a
                // pick, so offering the dropdown there would half-wire a mis-write — exclude only items. Parity with
                // net9. (A synthetic root token for ErrorProvider.ContainerControl = this is a separate future step.)
                if (owner is ToolStripItem) return null;
                if (pd.PropertyType.IsEnum) return null;
                var conv = pd.Converter;
                if (!(conv is ReferenceConverter)) return null;
                var asm = conv.GetType().Assembly;
                if (!ReferenceEquals(asm, typeof(ReferenceConverter).Assembly)
                    && !ReferenceEquals(asm, typeof(Control).Assembly)) return null;

                var names = new List<string>();
                string current = ReferenceNone;
                foreach (var kv in siblings)
                {
                    var sib = kv.Value;
                    if (ReferenceEquals(sib, owner)) continue;             // a component never references itself
                    if (raw != null && ReferenceEquals(sib, raw)) current = kv.Key; // current ref → its field name (same source as options)
                    if (!pd.PropertyType.IsInstanceOfType(sib)) continue;  // only assignable siblings
                    if (!string.IsNullOrEmpty(kv.Key) && !names.Contains(kv.Key)) names.Add(kv.Key);
                }
                // The ROOT form is an offered candidate whenever it is assignable (VS lists the form itself — e.g.
                // ErrorProvider.ContainerControl = this). Root carries no FieldNames entry (it was excluded from the
                // siblings the caller built), so it is the synthetic ReferenceThis token; exclude the degenerate
                // owner==root self-reference. The live write maps the token back to the root. Mirrors net9.
                bool rootAssignable = root != null && !ReferenceEquals(root, owner)
                    && pd.PropertyType.IsInstanceOfType(root);
                if (rootAssignable && raw != null && ReferenceEquals(raw, root)) current = ReferenceThis; // the root form itself
                // Only offer the dropdown when there is at least one candidate (a sibling OR the root) AND the CURRENT
                // reference is representable (null/"(none)", the root token, or a listed sibling). A live reference the
                // pairs can't name (a base-class field) leaves current == "(none)" though raw is non-null — keep the
                // plain field so we don't display it as cleared and don't diverge from net9.
                if (names.Count == 0 && !rootAssignable) return null;              // no candidate at all → plain field
                if (raw is IComponent && current == ReferenceNone) return null;    // a live reference we could not name → out of scope
                if (current != ReferenceNone && current != ReferenceThis && !names.Contains(current)) return null;
                names.Sort(StringComparer.Ordinal);
                var values = new List<string>(names.Count + 2) { ReferenceNone };
                if (rootAssignable) values.Add(ReferenceThis);                     // the form itself, right after "(none)"
                values.AddRange(names);
                return (values, current);
            }
            catch { return null; }
        }

        private static readonly TimeSpan ConverterQueryTimeout = TimeSpan.FromMilliseconds(200);
        /// <summary>How long a converter query may wait to be SCHEDULED before its own budget starts. Separate from
        /// <see cref="ConverterQueryTimeout"/> on purpose: queueing delay is the machine's fault, not the converter's,
        /// and charging it to the converter drops good metadata on a small or busy runner.</summary>
        private static readonly TimeSpan ConverterStartBudget = TimeSpan.FromSeconds(2);

        private static (List<string>?, bool, string?) StandardValuesOf(PropertyDescriptor pd, IComponent owner)
        {
            try
            {
                if (pd.PropertyType.IsEnum && pd.PropertyType.IsDefined(typeof(FlagsAttribute), false)) return (null, false, null);
                var conv = pd.Converter;
                if (conv == null) return (null, false, null);
                // ONLY the WinForms ImageIndex/ImageKey converters get a describe-time context (Instance = the component) —
                // they read the control's ATTACHED ImageList off context.Instance to enumerate its indices/keys. On the
                // compiled net48 instance the ImageList is real (its resx ImageStream loaded), so the dropdown shows real
                // keys. GATE on the WinForms ASSEMBLY (not just the name) so a same-named third-party converter never gets a
                // live mutation-capable context during a read-only describe. Every other converter is context-less. Mirrors net9.
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
                    // Skip the image converters' "no image" SENTINEL (ImageKey ""/ImageIndex -1, both displayed "(none)") — it
                    // does NOT round-trip through the primitive write path, so offer only REAL keys/indices. Filter by the
                    // actual value (not the display) so a legit key literally "(none)" survives. Mirrors net9.
                    if (isImageConv && ((sv is string ks && ks.Length == 0) || (sv is int ki && ki < 0))) continue;
                    string? s = null;
                    try { if (conv.CanConvertTo(typeof(string))) s = conv.ConvertToInvariantString(sv); } catch { s = null; }
                    if (!string.IsNullOrEmpty(s) && !vals.Contains(s!)) vals.Add(s!);
                    if (vals.Count >= 256) break;
                }
                // vals.Count==0 → no dropdown; for an image converter that's an absent/empty ImageList (sentinel filtered).
                // A populated 1-image no-sentinel NoneExcludedImageIndexConverter (yields exactly [0]) correctly still shows.
                if (vals.Count == 0) return (null, false, metadataDiagnosticCode);
                bool excl = false;
                try { excl = ctx != null ? conv.GetStandardValuesExclusive(ctx) : conv.GetStandardValuesExclusive(); }
                catch { try { excl = conv.GetStandardValuesExclusive(); } catch { excl = false; } }
                return (vals, excl, metadataDiagnosticCode);
            }
            catch { return (null, false, null); }
        }

        /// <summary>Converter standard-values set, PREFERRING the context-aware overload (so ImageIndexConverter/
        /// ImageKeyConverter resolve the attached ImageList) with a context-less fallback — strictly non-regressing.
        /// Mirrors net9's DesignerDescribe.StandardValuesColl.</summary>
        private static System.Collections.ICollection? StandardValuesColl(TypeConverter conv, ITypeDescriptorContext? ctx,
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
                System.Collections.ICollection? values = null;
                bool valuesTimedOut = false;
                bool valuesQuery = supportedQuery && supported
                    && TryRunConverterQuery(() => conv.GetStandardValues(ctx), out values, out valuesTimedOut);
                if (valuesTimedOut)
                {
                    metadataDiagnosticCode = "CONVERTER_TIMEOUT";
                    return null;
                }
                if (valuesQuery && values != null) return values;
            }
            bool contextlessSupportedQuery = TryRunConverterQuery(
                () => conv.GetStandardValuesSupported(), out bool contextlessSupported, out bool contextlessSupportedTimedOut);
            if (contextlessSupportedTimedOut)
            {
                metadataDiagnosticCode = "CONVERTER_TIMEOUT";
                return null;
            }
            System.Collections.ICollection? contextlessValues = null;
            bool contextlessValuesTimedOut = false;
            bool contextlessValuesQuery = contextlessSupportedQuery && contextlessSupported
                && TryRunConverterQuery(() => conv.GetStandardValues(), out contextlessValues, out contextlessValuesTimedOut);
            if (contextlessValuesTimedOut)
            {
                metadataDiagnosticCode = "CONVERTER_TIMEOUT";
                return null;
            }
            if (contextlessValuesQuery && contextlessValues != null) return contextlessValues;
            return null;
        }

        /// <summary>Minimal <see cref="ITypeDescriptorContext"/> for a describe-time TypeConverter query — carries the
        /// component (Instance) + property (PropertyDescriptor) so ImageIndexConverter/ImageKeyConverter can read the
        /// control's related ImageList. Container/services best-effort off the site. Mirrors net9's DescribeContext.</summary>
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

        private static List<string>? FlagsMembersOf(Type t)
        {
            try
            {
                if (!t.IsEnum || !t.IsDefined(typeof(FlagsAttribute), false)) return null;
                var members = new List<string>();
                foreach (var name in Enum.GetNames(t))
                {
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
                    if (u == 0) continue;
                    if ((u & (u - 1)) != 0) continue;
                    members.Add(name);
                }
                return members.Count > 0 ? members : null;
            }
            catch { return null; }
        }

        private static string? FlagsZeroOf(Type t)
        {
            try
            {
                if (!t.IsEnum || !t.IsDefined(typeof(FlagsAttribute), false)) return null;
                return Enum.GetName(t, Enum.ToObject(t, 0L));
            }
            catch { return null; }
        }

        private static bool IsImageProperty(Type t) =>
            typeof(System.Drawing.Image).IsAssignableFrom(t) || t == typeof(System.Drawing.Icon);

        private const int ThumbMax = 64;
        private const long MaxSrcPixels = 4096L * 4096L;

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
                    if (w <= 0 || h <= 0 || w > 20000 || h > 20000 || (long)w * h > MaxSrcPixels) return null;
                    double scale = Math.Min(1.0, Math.Min((double)ThumbMax / w, (double)ThumbMax / h));
                    int tw = Math.Max(1, (int)Math.Round(w * scale));
                    int th = Math.Max(1, (int)Math.Round(h * scale));
                    using (var thumb = new System.Drawing.Bitmap(tw, th, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                    {
                        using (var g = System.Drawing.Graphics.FromImage(thumb))
                        {
                            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                            g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.Half;
                            g.DrawImage(src, new System.Drawing.Rectangle(0, 0, tw, th));
                        }
                        using (var ms = new System.IO.MemoryStream())
                        {
                            thumb.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                            return Convert.ToBase64String(ms.ToArray());
                        }
                    }
                }
                finally { icoBmp?.Dispose(); }
            }
            catch { return null; }
        }

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
            Task<T> task;
            // NOT disposed and NOT a `using`: a query we abandon still sets this from its own thread long after we
            // have returned, and ManualResetEventSlim.Set() on a disposed instance throws on a pool thread.
            var started = new System.Threading.ManualResetEventSlim(false);
            try
            {
                task = Task.Run(() => { started.Set(); return query(); });
            }
            catch
            {
                result = default;
                return false;
            }

            try
            {
                // The budget bounds the CONVERTER, not the queue. Wait for the work to actually begin first: a
                // stalled converter leaves its thread sleeping, .NET injects replacement pool threads slowly, and on
                // a small or busy machine the whole budget can be spent before the next converter runs a single
                // instruction. That made a property lose its VALUE — not just its dropdown — which is how the S043
                // net48 describe failed on a CI runner while passing on every developer machine.
                started.Wait(ConverterStartBudget);
                if (task.Wait(ConverterQueryTimeout))
                {
                    result = task.GetAwaiter().GetResult();
                    return true;
                }
            }
            catch
            {
                result = default;
                return false;
            }

            ObserveLateConverterFault(task);
            timedOut = true;
            result = default;
            return false;
        }

        private static void ObserveLateConverterFault(Task task)
        {
            _ = task.ContinueWith(
                completed => { var ignored = completed.Exception; },
                System.Threading.CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously | TaskContinuationOptions.OnlyOnFaulted,
                TaskScheduler.Default);
        }
    }
}
