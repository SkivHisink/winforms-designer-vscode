using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>Result of <see cref="DesignerControlEditor.AddControl"/>: the new .Designer.cs text with a
    /// control added (field declaration + InitializeComponent statements), and the generated control name.
    /// <see cref="NewText"/> is null when the add was rejected.</summary>
    public sealed class ControlAddResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string? NewText { get; init; }
        public string Name { get; init; } = "";
    }

    /// <summary>Result of <see cref="DesignerControlEditor.RemoveControl"/>: the new .Designer.cs text with a
    /// control removed (its field declaration + all its InitializeComponent statements). Null on reject.</summary>
    public sealed class ControlRemoveResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string? NewText { get; init; }
    }

    /// <summary>Result of <see cref="DesignerControlEditor.CopyControl"/>: an OPAQUE clipboard blob (the engine's
    /// own JSON — the host just stores it and hands it back to <see cref="DesignerControlEditor.PasteControl"/>),
    /// describing the copied control's field type, original name, and the InitializeComponent statements that
    /// build it. Null on reject (root / shared field / a control entangled in another statement).</summary>
    public sealed class ControlCopyResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string? Clip { get; init; }
    }

    /// <summary>Result of <see cref="DesignerControlEditor.PasteControl"/>: the new .Designer.cs text with the
    /// pasted clone (a fresh field + renamed/offset statements + a Controls.Add into the target), and its
    /// generated name. Null on reject.</summary>
    public sealed class ControlPasteResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string? NewText { get; init; }
        public string Name { get; init; } = "";
    }

    /// <summary>Result of <see cref="DesignerControlEditor.MoveZOrder"/> (Bring to Front / Send to Back): the
    /// reordered .Designer.cs text. <see cref="NewText"/> equals the input (a no-op) when the control is already
    /// at the requested end of its sibling z-order; null on reject.</summary>
    public sealed class ControlReorderResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string? NewText { get; init; }
    }

    /// <summary>One toolbox-eligible control type surfaced to the palette (§7.2 auto-population): its short
    /// key (used as the AddControl <c>controlTypeKey</c>), assembly-qualified-ish full name (display/grouping
    /// only — never trusted to reach <c>new</c>; AddControl re-resolves the key against the enumerated set),
    /// VS-style category, and whether it came from the resolved project assembly vs the framework.</summary>
    public sealed class ToolboxItemInfo
    {
        public string Name { get; init; } = "";
        public string Fqn { get; init; } = "";
        public string Category { get; init; } = "";
        public bool FromProject { get; init; }
    }

    /// <summary>One row of the "Choose Toolbox Items" dialog — a richer, LISTING-only view than the palette: any
    /// toolbox-eligible Control OR Component type with the assembly metadata VS shows (Name / Namespace /
    /// Assembly Name / Version / Directory). Listing only — these never feed AddControl (which has its own gate).</summary>
    public sealed class ToolboxCandidate
    {
        public string Name { get; init; } = "";
        public string Namespace { get; init; } = "";
        public string AssemblyName { get; init; } = "";
        public string Version { get; init; } = "";
        public string Directory { get; init; } = "";
        public bool FromProject { get; init; }
    }

    /// <summary>The outcome of scanning ONE assembly for the Choose-Items dialog (the Browse… path): the
    /// assembly's simple name, the toolbox-eligible types found, and a human-readable reason when nothing
    /// usable was found (e.g. a .NET Framework / non-.NET assembly that can't load in the .NET host, or one
    /// with no Control/Component types) — so the dialog can tell the user instead of silently doing nothing.</summary>
    public sealed class ToolboxScanResult
    {
        public string AssemblyName { get; init; } = "";
        public List<ToolboxCandidate> Items { get; init; } = new();
        public string? Error { get; init; }
    }

    /// <summary>
    /// Add a standard WinForms control to a .Designer.cs as a MINIMAL text edit (a new field declaration +
    /// the control's InitializeComponent statements), mirroring <see cref="DesignerPropertyEditor"/>/<see
    /// cref="DesignerEventEditor"/> for the "toolbox add" path. Kept SEPARATE so the proven edit paths are
    /// untouched (§6.5). NO graph load / interpreter change is needed: the generated `this.X = new T();` /
    /// `Controls.Add` statements are interpreted by the EXISTING engine (which creates controls via
    /// host.CreateComponent, NOT Eval — so the Eval construction allowlist is irrelevant here). Safety is two
    /// gates: the control type must be in a FIXED allowlist of standard controls (no arbitrary type name
    /// reaches `new`), and <see cref="OnlyControlAdded"/> verifies the edit ONLY added the new control.
    /// </summary>
    public static class DesignerControlEditor
    {
        private sealed class Spec
        {
            public string Fqn = "";
            public int W;
            public int H;
            public bool SetText; // VS sets Text = name for Button/Label/CheckBox/RadioButton/GroupBox
        }

        // FIXED allowlist of standard System.Windows.Forms controls offered by the toolbox. A control type
        // NOT in this table is rejected — so a crafted/arbitrary type name can never reach `new <T>()`.
        private static readonly Dictionary<string, Spec> Allow = new(StringComparer.OrdinalIgnoreCase)
        {
            ["Button"] = new() { Fqn = "System.Windows.Forms.Button", W = 75, H = 23, SetText = true },
            ["Label"] = new() { Fqn = "System.Windows.Forms.Label", W = 38, H = 15, SetText = true },
            ["TextBox"] = new() { Fqn = "System.Windows.Forms.TextBox", W = 100, H = 23, SetText = false },
            ["CheckBox"] = new() { Fqn = "System.Windows.Forms.CheckBox", W = 80, H = 19, SetText = true },
            ["RadioButton"] = new() { Fqn = "System.Windows.Forms.RadioButton", W = 90, H = 19, SetText = true },
            ["ComboBox"] = new() { Fqn = "System.Windows.Forms.ComboBox", W = 120, H = 23, SetText = false },
            ["ListBox"] = new() { Fqn = "System.Windows.Forms.ListBox", W = 120, H = 95, SetText = false },
            ["Panel"] = new() { Fqn = "System.Windows.Forms.Panel", W = 200, H = 100, SetText = false },
            ["GroupBox"] = new() { Fqn = "System.Windows.Forms.GroupBox", W = 200, H = 100, SetText = true },
            ["PictureBox"] = new() { Fqn = "System.Windows.Forms.PictureBox", W = 100, H = 50, SetText = false },
        };

        /// <summary>VS-style toolbox categories for well-known framework controls. Anything not listed lands in
        /// <see cref="DefaultCategory"/>. Presentation only — grouping in the palette, never a security gate.</summary>
        private const string DefaultCategory = "All Windows Forms";
        private static readonly Dictionary<string, string> Category = new(StringComparer.Ordinal)
        {
            // Common Controls
            ["Button"] = "Common Controls", ["CheckBox"] = "Common Controls", ["CheckedListBox"] = "Common Controls",
            ["ComboBox"] = "Common Controls", ["DateTimePicker"] = "Common Controls", ["Label"] = "Common Controls",
            ["LinkLabel"] = "Common Controls", ["ListBox"] = "Common Controls", ["ListView"] = "Common Controls",
            ["MaskedTextBox"] = "Common Controls", ["MonthCalendar"] = "Common Controls", ["NumericUpDown"] = "Common Controls",
            ["PictureBox"] = "Common Controls", ["ProgressBar"] = "Common Controls", ["RadioButton"] = "Common Controls",
            ["RichTextBox"] = "Common Controls", ["TextBox"] = "Common Controls", ["TreeView"] = "Common Controls",
            ["DomainUpDown"] = "Common Controls", ["TrackBar"] = "Common Controls", ["WebBrowser"] = "Common Controls",
            ["PropertyGrid"] = "Common Controls", ["HScrollBar"] = "Common Controls", ["VScrollBar"] = "Common Controls",
            // Containers
            ["FlowLayoutPanel"] = "Containers", ["GroupBox"] = "Containers", ["Panel"] = "Containers",
            ["SplitContainer"] = "Containers", ["TabControl"] = "Containers", ["TableLayoutPanel"] = "Containers",
            ["Splitter"] = "Containers",
            // Menus & Toolbars
            ["MenuStrip"] = "Menus & Toolbars", ["StatusStrip"] = "Menus & Toolbars",
            ["ToolStrip"] = "Menus & Toolbars", ["ToolStripContainer"] = "Menus & Toolbars", ["ToolStripPanel"] = "Menus & Toolbars",
            // Data / Printing
            ["DataGridView"] = "Data", ["BindingNavigator"] = "Data", ["PrintPreviewControl"] = "Printing",
        };

        private static string CategoryFor(string name) => Category.TryGetValue(name, out var c) ? c : DefaultCategory;

        // Lazily-discovered, process-stable framework toolbox controls (strings only — never live Type objects,
        // per §9 reload-safety; the set is re-derivable and AddControl re-resolves the key against it).
        private static List<ToolboxItemInfo>? _framework;

        /// <summary>Reflect <c>System.Windows.Forms</c> for every toolbox-eligible visual control (§7.2): public,
        /// concrete, parameterless-ctor, <see cref="System.Windows.Forms.Control"/>-derived, not <c>[ToolboxItem(false)]</c>,
        /// and a valid <c>Controls.Add</c> target (Forms / ToolStripDropDown menus excluded — they throw if parented).</summary>
        private static List<ToolboxItemInfo> DiscoverFramework()
        {
            if (_framework != null) return _framework;
            var list = new List<ToolboxItemInfo>();
            Type[] types;
            try { types = typeof(System.Windows.Forms.Control).Assembly.GetTypes(); }
            catch (System.Reflection.ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray()!; }
            foreach (var t in types)
            {
                if (t == null || !IsEligibleToolboxControl(t)) continue;
                list.Add(new ToolboxItemInfo { Name = t.Name, Fqn = t.FullName!, Category = CategoryFor(t.Name), FromProject = false });
            }
            // dedup with the SAME comparer ResolveSpec matches with (OrdinalIgnoreCase) so resolution is
            // deterministic even if the framework ever ships two control types differing only in case.
            _framework = list.GroupBy(i => i.Name, StringComparer.OrdinalIgnoreCase).Select(g => g.First())
                             .OrderBy(i => i.Name, StringComparer.Ordinal).ToList();
            return _framework;
        }

        /// <summary>The toolbox-eligibility predicate (§7.2), shared by framework discovery and project-assembly
        /// enumeration (<see cref="DesignerRenderer.EnumerateProjectControls"/>): a public, concrete, parameterless-ctor,
        /// <see cref="System.Windows.Forms.Control"/>-derived type that is a valid <c>Controls.Add</c> target — Forms /
        /// ToolStripDropDown menus excluded (they throw if parented), <c>[ToolboxItem(false)]</c>/<c>[DesignTimeVisible(false)]</c>
        /// and base/utility/editing-helper types excluded. Control is the Default-ALC type, so a project type loaded in
        /// a child ALC (shared assemblies deferred to Default) still resolves IsAssignableFrom correctly.</summary>
        public static bool IsEligibleToolboxControl(Type t)
        {
            if (!t.IsPublic || !t.IsClass || t.IsAbstract || t.IsGenericTypeDefinition || t.IsNested) return false;
            if (!typeof(System.Windows.Forms.Control).IsAssignableFrom(t)) return false;
            if (typeof(System.Windows.Forms.Form).IsAssignableFrom(t) || typeof(System.Windows.Forms.ToolStripDropDown).IsAssignableFrom(t)) return false;
            if (t.GetConstructor(Type.EmptyTypes) == null) return false;
            if (IsToolboxDisabled(t) || IsDesignTimeInvisible(t)) return false;
            if (BaseClassDenylist.Contains(t.Name) || t.Name.EndsWith("EditingControl", StringComparison.Ordinal)) return false;
            if (string.IsNullOrEmpty(t.FullName) || t.FullName!.IndexOf('+') >= 0) return false;
            return true;
        }

        /// <summary>Build a "Project Controls" palette item for a project-assembly control type (§7.2 Increment 2).</summary>
        public static ToolboxItemInfo MakeProjectInfo(Type t) =>
            new() { Name = t.Name, Fqn = t.FullName!, Category = "Project Controls", FromProject = true };

        /// <summary>Broader eligibility for the "Choose Toolbox Items" LISTING dialog: a public, concrete,
        /// parameterless-ctor type that is a Control OR an IComponent (so non-visual components — Timer, the
        /// dialogs, providers — are listed like in VS), excluding Forms / ToolStripDropDown menus and the
        /// base/utility/editing-helper types. Listing only — NEVER gates construction (AddControl has its own gate).</summary>
        public static bool IsToolboxDialogEligible(Type t)
        {
            if (!t.IsPublic || !t.IsClass || t.IsAbstract || t.IsGenericTypeDefinition || t.IsNested) return false;
            if (!typeof(System.Windows.Forms.Control).IsAssignableFrom(t) && !typeof(System.ComponentModel.IComponent).IsAssignableFrom(t)) return false;
            if (typeof(System.Windows.Forms.Form).IsAssignableFrom(t) || typeof(System.Windows.Forms.ToolStripDropDown).IsAssignableFrom(t)) return false;
            if (t.GetConstructor(Type.EmptyTypes) == null) return false;
            if (IsToolboxDisabled(t)) return false;
            if (BaseClassDenylist.Contains(t.Name) || t.Name.EndsWith("EditingControl", StringComparison.Ordinal)) return false;
            if (string.IsNullOrEmpty(t.FullName) || t.FullName!.IndexOf('+') >= 0) return false;
            return true;
        }

        /// <summary>Build a Choose-Items row: short name, namespace, and the type's assembly simple name,
        /// version and on-disk directory (the .NET equivalent of VS's GAC "Directory" column). Strings only.</summary>
        public static ToolboxCandidate MakeCandidate(Type t, bool fromProject)
        {
            var an = t.Assembly.GetName();
            string dir = "";
            try { dir = string.IsNullOrEmpty(t.Assembly.Location) ? "" : (System.IO.Path.GetDirectoryName(t.Assembly.Location) ?? ""); }
            catch { /* dynamic / no location */ }
            return new ToolboxCandidate
            {
                Name = t.Name,
                Namespace = t.Namespace ?? "",
                AssemblyName = an.Name ?? "",
                Version = an.Version?.ToString() ?? "",
                Directory = dir,
                FromProject = fromProject,
            };
        }

        // Standard framework assemblies that ship toolbox-relevant Controls/Components. System.Windows.Forms holds
        // the bulk (controls + dialogs + Timer + providers + ImageList + NotifyIcon + BindingSource…); the rest are
        // try-loaded by name for the non-visual Components VS lists (Process / EventLog / SerialPort / …).
        private static readonly string[] CandidateAssemblyNames =
        {
            "System.Drawing.Common", "System.ComponentModel.Primitives", "System.ComponentModel.TypeConverter",
            "System.Diagnostics.Process", "System.Diagnostics.EventLog", "System.Diagnostics.PerformanceCounter",
            "System.IO.Ports", "System.ServiceProcess.ServiceController", "System.DirectoryServices",
        };

        private static List<ToolboxCandidate>? _frameworkCandidates;

        /// <summary>All toolbox-eligible Control/Component types across the standard framework assemblies, as
        /// Choose-Items rows. Pure reflection (GetTypes/attributes), process-stable + cached. Never throws.</summary>
        public static List<ToolboxCandidate> FrameworkCandidates()
        {
            if (_frameworkCandidates != null) return _frameworkCandidates;
            var asms = new List<System.Reflection.Assembly> { typeof(System.Windows.Forms.Control).Assembly };
            foreach (var name in CandidateAssemblyNames)
            {
                try { asms.Add(System.Reflection.Assembly.Load(name)); } catch { /* not on this runtime → skip */ }
            }
            var list = new List<ToolboxCandidate>();
            foreach (var asm in asms.Distinct())
            {
                Type[] types;
                try { types = asm.GetTypes(); }
                catch (System.Reflection.ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray()!; }
                catch { continue; }
                foreach (var t in types)
                {
                    if (t == null) continue;
                    try { if (IsToolboxDialogEligible(t)) list.Add(MakeCandidate(t, false)); }
                    catch { /* skip a type that throws on reflection */ }
                }
            }
            _frameworkCandidates = list
                .GroupBy(c => c.Namespace + "." + c.Name + "|" + c.AssemblyName, StringComparer.Ordinal).Select(g => g.First())
                .OrderBy(c => c.Name, StringComparer.Ordinal).ToList();
            return _frameworkCandidates;
        }

        /// <summary>Abstract-in-spirit base / utility controls that are public+concrete (so they slip past the
        /// reflection filter) but VS never lists in the toolbox. The DataGridView*EditingControl helpers are
        /// excluded by name suffix instead.</summary>
        private static readonly HashSet<string> BaseClassDenylist = new(StringComparer.Ordinal)
        { "Control", "ContainerControl", "ScrollableControl", "UserControl" };

        /// <summary>True when the type carries <c>[ToolboxItem(false)]</c>. Read via CustomAttributeData so we
        /// don't depend on which assembly defines ToolboxItemAttribute, and only the bool-ctor form disables.</summary>
        private static bool IsToolboxDisabled(Type t)
        {
            foreach (var a in t.GetCustomAttributesData())
            {
                if (a.AttributeType.Name != "ToolboxItemAttribute") continue;
                if (a.ConstructorArguments.Count == 1 && a.ConstructorArguments[0].Value is bool b) return !b;
            }
            return false;
        }

        /// <summary>True when the type carries <c>[DesignTimeVisible(false)]</c> — the canonical "hidden from the
        /// toolbox / component tray" marker (catches internal editing helpers and the like).</summary>
        private static bool IsDesignTimeInvisible(Type t)
        {
            foreach (var a in t.GetCustomAttributesData())
            {
                if (a.AttributeType.Name != "DesignTimeVisibleAttribute") continue;
                if (a.ConstructorArguments.Count == 1 && a.ConstructorArguments[0].Value is bool b) return !b;
            }
            return false;
        }

        /// <summary>The auto-populated toolbox palette (§7.2): curated common controls keep their VS sizes, the
        /// rest of the framework's visual controls are discovered by reflection. One entry per short name.</summary>
        public static IReadOnlyList<ToolboxItemInfo> ToolboxItems => DiscoverFramework();

        /// <summary>The toolbox's control type keys (e.g. "Button", "Label", …) — back-compat for ListControlTypes.</summary>
        public static IReadOnlyList<string> ControlTypes => ToolboxItems.Select(i => i.Name).ToList();

        /// <summary>Resolve a requested toolbox key to an emit spec. Curated common controls keep their VS sizes
        /// and Text-defaulting; any other key is matched against the discovered framework set, then the supplied
        /// project-control set (§7.2 Increment 2) by Fqn or short name — the ONLY ways an arbitrary type name can
        /// reach <c>new</c>, so an unknown/crafted key is rejected here. A discovered/project control emits no Size
        /// (its runtime DefaultSize applies) and no Text. Returns null to reject.</summary>
        private static Spec? ResolveSpec(string key, IReadOnlyList<ToolboxItemInfo>? projectControls)
        {
            if (Allow.TryGetValue(key, out var s)) return s;
            var fw = DiscoverFramework().FirstOrDefault(i => string.Equals(i.Name, key, StringComparison.OrdinalIgnoreCase));
            if (fw != null) return new Spec { Fqn = fw.Fqn, W = 0, H = 0, SetText = false };
            if (projectControls != null)
            {
                var pc = projectControls.FirstOrDefault(i =>
                    string.Equals(i.Fqn, key, StringComparison.Ordinal) || string.Equals(i.Name, key, StringComparison.OrdinalIgnoreCase));
                if (pc != null) return new Spec { Fqn = pc.Fqn, W = 0, H = 0, SetText = false };
            }
            return null;
        }

        /// <summary>True when the key resolves WITHOUT a project-control set (curated or framework) — lets the host
        /// skip the (assembly-loading) project enumeration on the fast path.</summary>
        public static bool CanResolveWithoutProject(string key) => ResolveSpec(key, null) != null;

        public static ControlAddResult AddControl(string src, string parentId, string controlTypeKey,
            IReadOnlyList<ToolboxItemInfo>? projectControls = null, int? locX = null, int? locY = null)
        {
            var spec = ResolveSpec(controlTypeKey, projectControls);
            if (spec == null)
                return new ControlAddResult { Safe = false, Reason = "unknown control type: " + controlTypeKey };

            bool parentRoot = parentId is "this" or "";
            if (!parentRoot && !IsValidIdentifier(parentId))
                return new ControlAddResult { Safe = false, Reason = "invalid parent id: " + parentId };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null)
                return new ControlAddResult { Safe = false, Reason = "InitializeComponent not found" };

            var names = GatherFieldNames(cls);
            if (!parentRoot && !names.Contains(parentId))
                return new ControlAddResult { Safe = false, Reason = "unknown parent: " + parentId };

            string baseName = ShortName(spec.Fqn).ToLowerInvariant();
            string name = UniqueName(baseName, names);
            if (!IsValidIdentifier(name))
                return new ControlAddResult { Safe = false, Reason = "could not generate a valid control name" };

            int childCount = CountAddTo(init, parentId, parentRoot);
            int off = (childCount % 10) * 8;
            // a drop position (parent-relative) when dragged from the toolbox; else cascade by child count
            int x = Math.Max(0, locX ?? (13 + off));
            int y = Math.Max(0, locY ?? (13 + off));

            string nl = src.Contains("\r\n") ? "\r\n" : "\n";
            string indent = BodyIndent(src, init);
            string addTarget = parentRoot ? "this" : "this." + parentId;

            var sb = new StringBuilder();
            void S(string s) { sb.Append(indent).Append(s).Append(nl); }
            S($"this.{name} = new {spec.Fqn}();");
            S($"this.{name}.Location = new System.Drawing.Point({x}, {y});");
            S($"this.{name}.Name = \"{name}\";");
            if (spec.W > 0 && spec.H > 0) S($"this.{name}.Size = new System.Drawing.Size({spec.W}, {spec.H});");
            S($"this.{name}.TabIndex = {childCount};");
            if (spec.SetText) S($"this.{name}.Text = \"{name}\";");
            S($"{addTarget}.Controls.Add(this.{name});");

            int insertPos = InitInsertPos(src, init);
            string withStmts = src.Substring(0, insertPos) + sb.ToString() + src.Substring(insertPos);

            string fieldLine = FieldIndent(src, cls) + $"private {spec.Fqn} {name};" + nl;
            string? finalText = InsertField(withStmts, fieldLine);
            if (finalText == null)
                return new ControlAddResult { Safe = false, Reason = "could not place the field declaration" };

            bool parseOk = !CSharpSyntaxTree.ParseText(finalText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = OnlyControlAdded(src, finalText, name);
            if (!parseOk || !gateOk)
            {
                return new ControlAddResult
                {
                    Safe = false,
                    Name = name,
                    Reason = !parseOk ? "added text has syntax errors" : "edit changed more than the new control",
                };
            }
            return new ControlAddResult { Safe = true, Name = name, NewText = finalText };
        }

        /// <summary>§6.5 gate: every ORIGINAL InitializeComponent statement is preserved unchanged, every EXTRA
        /// statement references only the new control, exactly ONE field declaration was added (the new one),
        /// and all original fields are preserved.</summary>
        public static bool OnlyControlAdded(string original, string edited, string name)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();

            var oInit = InitStatements(oRoot);
            var eInit = InitStatements(eRoot);
            // no original statement may be removed or altered (multiset subset check)
            var oMul = Counter(oInit);
            var eMul = Counter(eInit);
            foreach (var kv in oMul)
                if (!eMul.TryGetValue(kv.Key, out var n) || n < kv.Value) return false;
            // every statement the edit ADDED must reference the new control (token-boundary, like
            // OnlyControlRemoved — so a hand-injected "this.<name>_extra.X" can't slip past a substring match)
            foreach (var extra in MultisetSubtract(eInit, oInit))
                if (!RefsIdToken(extra, name)) return false;

            var oF = FieldDeclNames(oRoot);
            var eF = FieldDeclNames(eRoot);
            if (oF.Contains(name) || !eF.Contains(name)) return false;
            if (eF.Count != oF.Count + 1) return false;
            foreach (var f in oF) if (!eF.Contains(f)) return false;
            // defense in depth: the IC class gained EXACTLY ONE member (the new field) — counting ALL member kinds,
            // not just fields. A field-only check is blind to a property/method smuggled in via a crafted field-type
            // (e.g. PasteControl's Fqn closing the type early and opening 'int X { get {…} } private Button'); the
            // total-member delta catches it. AddControl always adds exactly one field, so this never rejects a real add.
            if (ClassMemberCount(eRoot) != ClassMemberCount(oRoot) + 1) return false;
            return true;
        }

        /// <summary>Total member count of the InitializeComponent-bearing class (all kinds: fields, properties,
        /// methods, …) — used by <see cref="OnlyControlAdded"/> to assert exactly one member (the new field) was added.</summary>
        private static int ClassMemberCount(SyntaxNode root) => FindClassWithIC(root)?.Members.Count ?? 0;

        /// <summary>
        /// Remove a LEAF control: delete its field declaration + every InitializeComponent statement that
        /// targets it (`this.&lt;id&gt; = new…`, `this.&lt;id&gt;.X = …`, `this.&lt;id&gt;.Event += …`) and the single
        /// `Controls.Add(this.&lt;id&gt;)` that parents it. Refuses (to avoid dangling references) when the control
        /// is the root, is a container WITH children, shares a field declaration, or is referenced as an
        /// ARGUMENT anywhere other than its own Controls.Add (AddRange / extender SetX / etc.).
        /// </summary>
        public static ControlRemoveResult RemoveControl(string src, string controlId)
        {
            if (controlId is "this" or "") return new ControlRemoveResult { Safe = false, Reason = "cannot remove the root form" };
            if (!IsValidIdentifier(controlId)) return new ControlRemoveResult { Safe = false, Reason = "invalid control id: " + controlId };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return new ControlRemoveResult { Safe = false, Reason = "InitializeComponent not found" };
            if (!GatherFieldNames(cls).Contains(controlId)) return new ControlRemoveResult { Safe = false, Reason = "unknown control: " + controlId };

            var removeStmts = new List<StatementSyntax>();
            foreach (var st in init.Body.Statements)
            {
                bool remove = ClassifyForRemoval(st, controlId, out bool refuse, out string? why);
                if (refuse) return new ControlRemoveResult { Safe = false, Reason = why ?? "control is referenced elsewhere" };
                if (remove) removeStmts.Add(st);
            }

            var fieldDecl = cls.Members.OfType<FieldDeclarationSyntax>()
                .FirstOrDefault(f => f.Declaration.Variables.Any(v => v.Identifier.Text == controlId));
            if (fieldDecl == null) return new ControlRemoveResult { Safe = false, Reason = "field declaration not found" };
            if (fieldDecl.Declaration.Variables.Count != 1)
                return new ControlRemoveResult { Safe = false, Reason = "control shares a field declaration with other fields" };

            var ranges = new List<(int s, int e)>();
            foreach (var st in removeStmts) ranges.Add(LineRange(src, st.SpanStart, st.Span.End));
            ranges.Add(LineRange(src, fieldDecl.SpanStart, fieldDecl.Span.End));
            ranges.Sort((a, b) => b.s.CompareTo(a.s)); // descending so earlier splices don't shift later offsets
            string text = src;
            foreach (var (s, e) in ranges) text = text.Substring(0, s) + text.Substring(e);

            bool parseOk = !CSharpSyntaxTree.ParseText(text).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = OnlyControlRemoved(src, text, controlId);
            if (!parseOk || !gateOk)
                return new ControlRemoveResult { Safe = false, Reason = !parseOk ? "edited text has syntax errors" : "edit changed more than the target control" };
            return new ControlRemoveResult { Safe = true, NewText = text };
        }

        /// <summary>Classify a statement for removing control <paramref name="id"/>: returns true to REMOVE it;
        /// sets <paramref name="refuse"/> when the statement blocks removal (container child / external ref).</summary>
        private static bool ClassifyForRemoval(StatementSyntax st, string id, out bool refuse, out string? why)
        {
            refuse = false; why = null;
            if (st is ExpressionStatementSyntax es)
            {
                if (es.Expression is AssignmentExpressionSyntax asg)
                {
                    var owner = Flatten(asg.Left);
                    if (owner.Count >= 1 && owner[0] == id) return true; // this.<id> = … / this.<id>.X = … / this.<id>.Event += …
                    if (ReferencesThisId(asg.Right, id)) { refuse = true; why = "control is referenced in an assignment value"; }
                    return false;
                }
                if (es.Expression is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax ma)
                {
                    var receiver = Flatten(ma.Expression);
                    string method = ma.Name.Identifier.Text;
                    if (receiver.Count >= 1 && receiver[0] == id)
                    {
                        // operating ON the control; a Controls.Add/AddRange on it means it has children → refuse
                        if (receiver.Count >= 2 && receiver[receiver.Count - 1] == "Controls" && (method == "Add" || method == "AddRange"))
                        { refuse = true; why = "control is a container with children — remove them first"; return false; }
                        return true;
                    }
                    bool argHasId = inv.ArgumentList.Arguments.Any(a => ReferencesThisId(a.Expression, id));
                    if (argHasId)
                    {
                        bool isParenting = method == "Add" && inv.ArgumentList.Arguments.Count == 1
                            && receiver.Count >= 1 && receiver[receiver.Count - 1] == "Controls"
                            && Flatten(inv.ArgumentList.Arguments[0].Expression) is { Count: 1 } ac && ac[0] == id;
                        if (isParenting) return true;
                        refuse = true; why = "control is referenced in " + method + "(...) — handle that first";
                    }
                    return false;
                }
            }
            if (ReferencesThisId(st, id)) { refuse = true; why = "control referenced in an unsupported statement"; }
            return false;
        }

        /// <summary>True when the node contains a <c>this.&lt;id&gt;</c> member access (exact identifier — AST,
        /// not substring, so button1 ≠ button10).</summary>
        private static bool ReferencesThisId(SyntaxNode node, string id) =>
            node.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>()
                .Any(m => m.Expression is ThisExpressionSyntax && m.Name.Identifier.Text == id);

        /// <summary>§6.5 gate: the edit only REMOVED statements (no add/change), every removed statement
        /// referenced the control, and exactly the control's field declaration was removed.</summary>
        public static bool OnlyControlRemoved(string original, string edited, string id)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            var oInit = InitStatements(oRoot);
            var eInit = InitStatements(eRoot);
            var oMul = Counter(oInit);
            var eMul = Counter(eInit);
            // edited may not ADD or CHANGE a statement (every edited stmt present in orig with >= count)
            foreach (var kv in eMul)
                if (!oMul.TryGetValue(kv.Key, out var n) || n < kv.Value) return false;
            // every REMOVED statement must have referenced the control
            foreach (var removed in MultisetSubtract(oInit, eInit))
                if (!RefsIdToken(removed, id)) return false;

            var oF = FieldDeclNames(oRoot);
            var eF = FieldDeclNames(eRoot);
            if (eF.Contains(id) || !oF.Contains(id)) return false;
            if (eF.Count != oF.Count - 1) return false;
            foreach (var f in eF) if (!oF.Contains(f)) return false;
            // defense-in-depth: NO surviving statement may still reference the removed control (no dangling ref)
            foreach (var s in eInit) if (RefsIdToken(s, id)) return false;
            return true;
        }

        // ---- copy / paste (clipboard) ----

        /// <summary>The opaque clipboard payload (the engine's own JSON): the copied control's field type, its
        /// original field name, and the InitializeComponent statements that build it (construction + property
        /// assignments — event wirings and the parenting Controls.Add are dropped; Paste regenerates the latter
        /// for the chosen target).</summary>
        private sealed class ClipData
        {
            public string Fqn { get; set; } = "";
            public string Name { get; set; } = "";
            public List<string> Statements { get; set; } = new();
        }

        /// <summary>
        /// Copy a LEAF control to an opaque clipboard blob: its field type + the InitializeComponent statements
        /// that build it (the <c>this.&lt;id&gt; = new…</c> ctor and every <c>this.&lt;id&gt;.X = …</c> / method call on it),
        /// EXCLUDING event wirings (<c>+=</c>) and the parenting <c>Controls.Add(this.&lt;id&gt;)</c> (Paste regenerates
        /// the Add for the chosen container). Refuses the root, a container WITH children, a shared field
        /// declaration, or a control referenced as an ARGUMENT elsewhere (AddRange / extender SetX / assignment
        /// value) — the same entanglement that blocks a faithful clone.
        /// </summary>
        public static ControlCopyResult CopyControl(string src, string controlId)
        {
            if (controlId is "this" or "") return new ControlCopyResult { Safe = false, Reason = "cannot copy the root form" };
            if (!IsValidIdentifier(controlId)) return new ControlCopyResult { Safe = false, Reason = "invalid control id: " + controlId };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return new ControlCopyResult { Safe = false, Reason = "InitializeComponent not found" };
            if (!GatherFieldNames(cls).Contains(controlId)) return new ControlCopyResult { Safe = false, Reason = "unknown control: " + controlId };

            var fieldDecl = cls.Members.OfType<FieldDeclarationSyntax>()
                .FirstOrDefault(f => f.Declaration.Variables.Any(v => v.Identifier.Text == controlId));
            if (fieldDecl == null) return new ControlCopyResult { Safe = false, Reason = "field declaration not found" };
            if (fieldDecl.Declaration.Variables.Count != 1)
                return new ControlCopyResult { Safe = false, Reason = "control shares a field declaration with other fields" };
            string fqn = fieldDecl.Declaration.Type.ToString();
            if (!IsValidTypeName(fqn)) return new ControlCopyResult { Safe = false, Reason = "control has an unrecognized field type" };

            var statements = new List<string>();
            foreach (var st in init.Body.Statements)
            {
                bool include = ClassifyForCopy(st, controlId, out bool refuse, out string? why);
                if (refuse) return new ControlCopyResult { Safe = false, Reason = why ?? "control is referenced elsewhere" };
                if (!include) continue;
                // Only clone statements we can FAITHFULLY reproduce: an assignment/layout-call on the control whose
                // values are designer-representable (literals, enums, Point/Size/Color/Font/… ) — never one that
                // references a sibling or calls into a non-designer type. This keeps the clip clean so PasteControl
                // (which re-validates identically) accepts a real copy while rejecting a crafted blob.
                if (st is not ExpressionStatementSyntax es || !IsAllowedControlStatement(es.Expression, controlId, fqn))
                    return new ControlCopyResult { Safe = false, Reason = "control has a statement that cannot be safely copied" };
                statements.Add(st.ToString());
            }
            if (statements.Count == 0) return new ControlCopyResult { Safe = false, Reason = "nothing to copy" };

            var clip = new ClipData { Fqn = fqn, Name = controlId, Statements = statements };
            return new ControlCopyResult { Safe = true, Clip = System.Text.Json.JsonSerializer.Serialize(clip) };
        }

        /// <summary>Classify a statement for COPYING control <paramref name="id"/>: returns true to CLONE it; sets
        /// <paramref name="refuse"/> when the statement blocks a faithful copy (container child / external ref).
        /// Mirrors <see cref="ClassifyForRemoval"/> but: keeps construction + property/method statements ON the
        /// control, drops event wirings (<c>+=</c>), and treats the parenting Add as "not cloned" (regenerated).</summary>
        private static bool ClassifyForCopy(StatementSyntax st, string id, out bool refuse, out string? why)
        {
            refuse = false; why = null;
            if (st is ExpressionStatementSyntax es)
            {
                if (es.Expression is AssignmentExpressionSyntax asg)
                {
                    var owner = Flatten(asg.Left);
                    if (owner.Count >= 1 && owner[0] == id)
                        return asg.IsKind(SyntaxKind.SimpleAssignmentExpression); // clone `=` (ctor/props); drop `+=` events
                    if (ReferencesThisId(asg.Right, id)) { refuse = true; why = "control is referenced in an assignment value"; }
                    return false;
                }
                if (es.Expression is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax ma)
                {
                    var receiver = Flatten(ma.Expression);
                    string method = ma.Name.Identifier.Text;
                    if (receiver.Count >= 1 && receiver[0] == id)
                    {
                        if (receiver.Count >= 2 && receiver[receiver.Count - 1] == "Controls" && (method == "Add" || method == "AddRange"))
                        { refuse = true; why = "control is a container with children — copying them together is not supported yet"; return false; }
                        return true; // a method call on the control (e.g. SuspendLayout) → clone it too
                    }
                    bool argHasId = inv.ArgumentList.Arguments.Any(a => ReferencesThisId(a.Expression, id));
                    if (argHasId)
                    {
                        bool isParenting = method == "Add" && inv.ArgumentList.Arguments.Count == 1
                            && receiver.Count >= 1 && receiver[receiver.Count - 1] == "Controls"
                            && Flatten(inv.ArgumentList.Arguments[0].Expression) is { Count: 1 } ac && ac[0] == id;
                        if (isParenting) return false; // the parenting Add — regenerated for the paste target, not cloned
                        refuse = true; why = "control is referenced in " + method + "(...) — cannot copy it in isolation";
                    }
                    return false;
                }
            }
            if (ReferencesThisId(st, id)) { refuse = true; why = "control referenced in an unsupported statement"; }
            return false;
        }

        /// <summary>How far a pasted control is nudged from the original so it doesn't perfectly overlap (VS does
        /// the same). Only applied to a representable integer Location.</summary>
        private const int PasteOffset = 8;

        /// <summary>
        /// Paste a clipboard blob (from <see cref="CopyControl"/>) into <paramref name="parentId"/> ("this" = root):
        /// generate a fresh unique name, clone the statements with the receiver renamed to it, keep its Name
        /// property in sync, nudge its Location, add a field declaration, and parent it with a Controls.Add into
        /// the target. Same §6.5 <see cref="OnlyControlAdded"/> gate as AddControl (only the new control was added).
        /// </summary>
        public static ControlPasteResult PasteControl(string src, string clipJson, string parentId)
        {
            ClipData? clip;
            try { clip = System.Text.Json.JsonSerializer.Deserialize<ClipData>(clipJson); }
            catch { return new ControlPasteResult { Safe = false, Reason = "clipboard data is not valid" }; }
            if (clip == null || string.IsNullOrEmpty(clip.Fqn) || clip.Statements == null || clip.Statements.Count == 0)
                return new ControlPasteResult { Safe = false, Reason = "clipboard is empty" };
            if (!IsValidIdentifier(clip.Name)) return new ControlPasteResult { Safe = false, Reason = "clipboard control name is invalid" };
            // The clip is NOT guaranteed to come from CopyControl (it arrives raw over RPC); the Fqn is emitted into a
            // class-scope field declaration, so a crafted one could declare an extra member. Require a bare dotted
            // type name (no ';', '{', '=', extra tokens) — this is what closes the field-injection vector.
            if (!IsValidTypeName(clip.Fqn)) return new ControlPasteResult { Safe = false, Reason = "clipboard control type is invalid" };

            bool parentRoot = parentId is "this" or "";
            if (!parentRoot && !IsValidIdentifier(parentId))
                return new ControlPasteResult { Safe = false, Reason = "invalid parent id: " + parentId };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return new ControlPasteResult { Safe = false, Reason = "InitializeComponent not found" };

            var names = GatherFieldNames(cls);
            if (!parentRoot && !names.Contains(parentId)) return new ControlPasteResult { Safe = false, Reason = "unknown parent: " + parentId };

            string baseName = ShortName(clip.Fqn).ToLowerInvariant();
            if (!IsValidIdentifier(baseName)) baseName = "control"; // guard against an odd clipboard Fqn short name
            string newName = UniqueName(baseName, names);
            if (!IsValidIdentifier(newName)) return new ControlPasteResult { Safe = false, Reason = "could not generate a control name" };

            string nl = src.Contains("\r\n") ? "\r\n" : "\n";
            string indent = BodyIndent(src, init);
            string addTarget = parentRoot ? "this" : "this." + parentId;

            var sb = new StringBuilder();
            // emit one cloned statement, re-indenting EVERY physical line to the target body indent (a multi-line
            // initializer keeps its continuation lines aligned instead of pasting the source file's indentation)
            void S(string s)
            {
                foreach (var ln in s.Split('\n'))
                {
                    string line = ln.TrimEnd('\r');
                    if (line.Trim().Length == 0) continue;
                    sb.Append(indent).Append(line.TrimStart()).Append(nl);
                }
            }
            foreach (var raw in clip.Statements)
            {
                // Re-validate + rename + retouch each statement on the AST: reject any statement that is not an
                // assignment/layout-call on the control with designer-representable values (this is the second line of
                // defense against a crafted clip injecting a side-effecting RHS), then rename the receiver on the tree
                // (string literals untouched), sync Name, and offset Location.
                string? processed = ProcessPastedStatement(raw, clip.Name, newName, clip.Fqn);
                if (processed == null) return new ControlPasteResult { Safe = false, Reason = "clipboard contains an unsupported statement" };
                S(processed);
            }
            S($"{addTarget}.Controls.Add(this.{newName});");

            int insertPos = InitInsertPos(src, init);
            string withStmts = src.Substring(0, insertPos) + sb.ToString() + src.Substring(insertPos);

            string fieldLine = FieldIndent(src, cls) + $"private {clip.Fqn} {newName};" + nl;
            string? finalText = InsertField(withStmts, fieldLine);
            if (finalText == null) return new ControlPasteResult { Safe = false, Reason = "could not place the field declaration" };

            bool parseOk = !CSharpSyntaxTree.ParseText(finalText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = OnlyControlAdded(src, finalText, newName);
            if (!parseOk || !gateOk)
                return new ControlPasteResult { Safe = false, Name = newName, Reason = !parseOk ? "pasted text has syntax errors" : "paste changed more than the new control" };
            return new ControlPasteResult { Safe = true, Name = newName, NewText = finalText };
        }

        /// <summary>Validate + rename + retouch ONE cloned statement on the AST, returning the emit text or null to
        /// REJECT. Validation (<see cref="IsAllowedControlStatement"/>) requires an assignment/layout-call on
        /// <paramref name="oldId"/> with designer-representable values — so a crafted clip can't smuggle a
        /// side-effecting RHS or a sibling reference. The receiver rename is done on the syntax tree (string literals
        /// and comments are never touched), the <c>Name</c> property is kept equal to the new field name, and an
        /// integer <c>Location</c> is nudged by <see cref="PasteOffset"/>.</summary>
        private static string? ProcessPastedStatement(string rawStmt, string oldId, string newName, string fqn)
        {
            var parsed = SyntaxFactory.ParseStatement(rawStmt);
            if (parsed.ContainsDiagnostics || parsed is not ExpressionStatementSyntax es) return null;
            if (!IsAllowedControlStatement(es.Expression, oldId, fqn)) return null;

            var renamed = (ExpressionStatementSyntax)new ThisReceiverRenamer(oldId, newName).Visit(es)!;
            if (renamed.Expression is AssignmentExpressionSyntax asg && asg.Left is MemberAccessExpressionSyntax ma)
            {
                string member = ma.Name.Identifier.Text;
                if (member == "Name" && asg.Right is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
                {
                    var newLit = SyntaxFactory.LiteralExpression(SyntaxKind.StringLiteralExpression, SyntaxFactory.Literal(newName)).WithTriviaFrom(lit);
                    renamed = renamed.ReplaceNode(asg.Right, newLit);
                }
                else if (member == "Location" && asg.Right is ObjectCreationExpressionSyntax oce && oce.ArgumentList?.Arguments.Count == 2
                    && TryConstInt(oce.ArgumentList.Arguments[0].Expression, out int x) && TryConstInt(oce.ArgumentList.Arguments[1].Expression, out int y))
                {
                    var pt = SyntaxFactory.ParseExpression($"new {oce.Type}({Math.Max(0, x + PasteOffset)}, {Math.Max(0, y + PasteOffset)})").WithTriviaFrom(oce);
                    renamed = renamed.ReplaceNode(oce, pt);
                }
            }
            return renamed.ToString();
        }

        /// <summary>An AST rewriter that renames <c>this.&lt;oldId&gt;</c> receiver accesses to <c>this.&lt;newId&gt;</c>
        /// (member-access whose target is <c>this</c> and whose name is <c>oldId</c>) — string literals and comments
        /// are untouched, unlike a raw-text replace.</summary>
        private sealed class ThisReceiverRenamer : CSharpSyntaxRewriter
        {
            private readonly string _old, _new;
            public ThisReceiverRenamer(string oldId, string newId) { _old = oldId; _new = newId; }
            public override SyntaxNode? VisitMemberAccessExpression(MemberAccessExpressionSyntax node)
            {
                var visited = (MemberAccessExpressionSyntax)base.VisitMemberAccessExpression(node)!;
                if (visited.Expression is ThisExpressionSyntax && visited.Name.Identifier.Text == _old)
                    return visited.WithName(SyntaxFactory.IdentifierName(SyntaxFactory.Identifier(_new)).WithTriviaFrom(visited.Name));
                return visited;
            }
        }

        // Designer value namespaces/types a cloned property value may construct/call (Point/Size/Color/Font/Padding/…)
        // — anything else (System.IO, System.Diagnostics, a project type, …) makes the statement non-copyable.
        private static readonly string[] SafeValuePrefixes = { "System.Drawing", "System.Windows.Forms", "System.ComponentModel" };
        private static readonly HashSet<string> SafeValueTypeNames = new(StringComparer.Ordinal)
        { "Point", "PointF", "Size", "SizeF", "Rectangle", "RectangleF", "Color", "SystemColors", "Font", "FontFamily", "Padding" };
        private static readonly HashSet<string> CopyableMethods = new(StringComparer.Ordinal)
        { "SuspendLayout", "ResumeLayout", "PerformLayout", "BeginInit", "EndInit" };

        /// <summary>True when <paramref name="expr"/> is a statement a control can OWN and a copy can faithfully
        /// reproduce: <c>this.&lt;id&gt; = new &lt;fqn&gt;(safeArgs)</c> (the ctor), <c>this.&lt;id&gt;.&lt;member…&gt; = &lt;safe value&gt;</c>
        /// (a property), or <c>this.&lt;id&gt;.&lt;layoutMethod&gt;(safeArgs)</c>. Anything else (a Controls.Add, a sibling
        /// reference, a non-designer call) is rejected.</summary>
        private static bool IsAllowedControlStatement(ExpressionSyntax expr, string ownerId, string fqn)
        {
            if (expr is AssignmentExpressionSyntax asg)
            {
                if (!asg.IsKind(SyntaxKind.SimpleAssignmentExpression)) return false;
                var lhs = Flatten(asg.Left);
                if (lhs.Count < 1 || lhs[0] != ownerId) return false;
                if (lhs.Count == 1)
                    return asg.Right is ObjectCreationExpressionSyntax oc && oc.Type.ToString() == fqn
                        && (oc.ArgumentList == null || oc.ArgumentList.Arguments.All(a => IsSafeValueExpr(a.Expression)));
                return IsSafeValueExpr(asg.Right);
            }
            if (expr is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax ma)
            {
                var recv = Flatten(ma.Expression);
                if (recv.Count == 1 && recv[0] == ownerId && CopyableMethods.Contains(ma.Name.Identifier.Text))
                    return inv.ArgumentList.Arguments.All(a => IsSafeValueExpr(a.Expression));
            }
            return false;
        }

        /// <summary>True when an expression is a designer-representable VALUE: literals, enum/static member reads, and
        /// constructions/calls of designer value types (Point/Size/Color/Font/…). Rejects any <c>this.&lt;x&gt;</c>
        /// reference (no sibling refs in a value), lambdas, await, and any construction/invocation of a non-designer
        /// type (System.IO.File.ReadAllText, System.Diagnostics.Process.Start, a project type, …).</summary>
        private static bool IsSafeValueExpr(ExpressionSyntax expr)
        {
            foreach (var node in expr.DescendantNodesAndSelf())
            {
                switch (node)
                {
                    case AnonymousFunctionExpressionSyntax: return false;
                    case AwaitExpressionSyntax: return false;
                    case MemberAccessExpressionSyntax m when m.Expression is ThisExpressionSyntax: return false;
                    case ObjectCreationExpressionSyntax oc when !IsSafeTypeRef(oc.Type.ToString()): return false;
                    case InvocationExpressionSyntax iv:
                        if (iv.Expression is not MemberAccessExpressionSyntax callee || !IsSafeTypeRef(callee.Expression.ToString())) return false;
                        break;
                }
            }
            return true;
        }

        /// <summary>True when a type/receiver path is a designer value type — fully-qualified under a safe namespace
        /// (System.Drawing.*, …) or a recognized short name (Color, Point, Padding, …) for a <c>using</c>-shortened form.</summary>
        private static bool IsSafeTypeRef(string path)
        {
            path = path.Trim();
            foreach (var p in SafeValuePrefixes) if (path == p || path.StartsWith(p + ".", StringComparison.Ordinal)) return true;
            int dot = path.LastIndexOf('.');
            string shortName = dot < 0 ? path : path.Substring(dot + 1);
            int lt = shortName.IndexOf('<'); if (lt >= 0) shortName = shortName.Substring(0, lt);
            return SafeValueTypeNames.Contains(shortName);
        }

        /// <summary>True when <paramref name="s"/> is a bare dotted type name — each segment a valid C# identifier,
        /// nothing else (no ';', '{', '=', whitespace, or extra tokens). Generic/array/nested types are rejected
        /// (standard control fields are simple dotted names), which is exactly what blocks Fqn member-injection.</summary>
        public static bool IsValidTypeName(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            foreach (var seg in s.Split('.'))
                if (!IsValidIdentifier(seg)) return false;
            return true;
        }

        /// <summary>A non-negative/negative integer literal (optionally with a unary minus), or false otherwise.</summary>
        private static bool TryConstInt(ExpressionSyntax e, out int val)
        {
            val = 0;
            if (e is LiteralExpressionSyntax l && l.Token.Value is int i) { val = i; return true; }
            if (e is PrefixUnaryExpressionSyntax p && p.IsKind(SyntaxKind.UnaryMinusExpression)
                && p.Operand is LiteralExpressionSyntax l2 && l2.Token.Value is int i2) { val = -i2; return true; }
            return false;
        }

        // ---- z-order (Bring to Front / Send to Back) ----

        /// <summary>
        /// Move a control to the FRONT (<paramref name="toFront"/> true) or BACK of its siblings' z-order by
        /// relocating its single <c>&lt;parent&gt;.Controls.Add(this.&lt;id&gt;)</c> statement among the sibling Add calls.
        /// WinForms z-order: the Controls collection paints back-to-front, index 0 is the FRONT, and Controls.Add
        /// appends (highest index = back); so the FIRST Add in InitializeComponent is the front-most and the LAST
        /// is the back-most. Bring-to-Front therefore moves the Add before the first sibling Add; Send-to-Back
        /// after the last. The edit ONLY reorders that one line (verified by <see cref="OnlyReordered"/>).
        /// </summary>
        public static ControlReorderResult MoveZOrder(string src, string controlId, bool toFront)
        {
            if (controlId is "this" or "") return new ControlReorderResult { Safe = false, Reason = "cannot reorder the root form" };
            if (!IsValidIdentifier(controlId)) return new ControlReorderResult { Safe = false, Reason = "invalid control id: " + controlId };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            if (cls == null || init?.Body == null) return new ControlReorderResult { Safe = false, Reason = "InitializeComponent not found" };
            if (!GatherFieldNames(cls).Contains(controlId)) return new ControlReorderResult { Safe = false, Reason = "unknown control: " + controlId };

            StatementSyntax? mine = null;
            List<string>? myParent = null;
            foreach (var st in init.Body.Statements)
                if (IsControlsAddOf(st, out var pchain, out var child) && child == controlId) { mine = st; myParent = pchain; break; }
            if (mine == null || myParent == null)
                return new ControlReorderResult { Safe = false, Reason = "control is not parented (no Controls.Add) — cannot reorder" };

            // refuse when the same container ALSO parents children via Controls.AddRange: those aren't in the Add
            // sequence, so a front/back move computed against the Add-only siblings wouldn't reflect the true z-order.
            foreach (var st in init.Body.Statements)
                if (IsControlsAddRangeOf(st, out var rchain) && SameChain(rchain, myParent))
                    return new ControlReorderResult { Safe = false, Reason = "z-order is not supported in a container that uses Controls.AddRange" };

            var siblings = new List<StatementSyntax>();
            foreach (var st in init.Body.Statements)
                if (IsControlsAddOf(st, out var pchain, out _) && SameChain(pchain, myParent)) siblings.Add(st);
            if (siblings.Count <= 1) return new ControlReorderResult { Safe = true, NewText = src }; // only child → no-op

            int curIdx = siblings.IndexOf(mine);
            if (toFront ? curIdx == 0 : curIdx == siblings.Count - 1)
                return new ControlReorderResult { Safe = true, NewText = src }; // already at the requested end

            var anchor = toFront ? siblings[0] : siblings[siblings.Count - 1];
            var (ms, me) = LineRange(src, mine.SpanStart, mine.Span.End);
            // refuse when the Add shares its physical line with another statement — the whole-line move would drag the
            // neighbor along, and OnlyReordered's multiset check wouldn't catch the relative-order change.
            foreach (var st in init.Body.Statements)
                if (st != mine && st.SpanStart >= ms && st.SpanStart < me)
                    return new ControlReorderResult { Safe = false, Reason = "the Controls.Add shares a line with another statement — reformat first" };
            var (as_, ae) = LineRange(src, anchor.SpanStart, anchor.Span.End);
            string mineText = src.Substring(ms, me - ms);
            string removed = src.Substring(0, ms) + src.Substring(me);
            // toFront: anchor (first sibling) is before `mine` (ms > as_) → insert at as_ (unshifted by the later removal).
            // toBack:  anchor (last sibling) is after  `mine` (ms < as_) → insert at the anchor's end, shifted left by the removal.
            int insertAt = toFront ? as_ : ae - (me - ms);
            string text = removed.Substring(0, insertAt) + mineText + removed.Substring(insertAt);

            bool parseOk = !CSharpSyntaxTree.ParseText(text).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            if (!parseOk || !OnlyReordered(src, text))
                return new ControlReorderResult { Safe = false, Reason = !parseOk ? "reordered text has syntax errors" : "edit changed more than the z-order" };
            return new ControlReorderResult { Safe = true, NewText = text };
        }

        /// <summary>True when <paramref name="st"/> is <c>&lt;chain&gt;.Controls.Add(this.&lt;child&gt;)</c>; yields the
        /// PARENT chain (the receiver minus its trailing "Controls" — empty for the root form) and the child id.</summary>
        private static bool IsControlsAddOf(StatementSyntax st, out List<string> parentChain, out string? childId)
        {
            parentChain = new List<string>(); childId = null;
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.Text != "Add") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count == 0 || chain[chain.Count - 1] != "Controls") return false;
            if (inv.ArgumentList.Arguments.Count != 1) return false;
            var argChain = Flatten(inv.ArgumentList.Arguments[0].Expression);
            if (argChain.Count != 1) return false;
            childId = argChain[0];
            parentChain = chain.Take(chain.Count - 1).ToList();
            return true;
        }

        /// <summary>True when <paramref name="st"/> is <c>&lt;chain&gt;.Controls.AddRange(...)</c>; yields the PARENT chain
        /// (receiver minus the trailing "Controls"). Used to refuse z-order in a container that mixes AddRange.</summary>
        private static bool IsControlsAddRangeOf(StatementSyntax st, out List<string> parentChain)
        {
            parentChain = new List<string>();
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.Text != "AddRange") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count == 0 || chain[chain.Count - 1] != "Controls") return false;
            parentChain = chain.Take(chain.Count - 1).ToList();
            return true;
        }

        private static bool SameChain(List<string> a, List<string> b) => a.Count == b.Count && a.SequenceEqual(b, StringComparer.Ordinal);

        /// <summary>§6.5 gate for a z-order move: the InitializeComponent statement multiset and the field
        /// declarations are IDENTICAL to the original (only the order of one statement changed).</summary>
        public static bool OnlyReordered(string original, string edited)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            var oInit = InitStatements(oRoot);
            var eInit = InitStatements(eRoot);
            if (oInit.Count != eInit.Count) return false;
            var oMul = Counter(oInit); var eMul = Counter(eInit);
            if (oMul.Count != eMul.Count) return false;
            foreach (var kv in oMul) if (!eMul.TryGetValue(kv.Key, out var n) || n != kv.Value) return false;
            var oF = Counter(FieldDeclNames(oRoot)); var eF = Counter(FieldDeclNames(eRoot));
            if (oF.Count != eF.Count) return false;
            foreach (var kv in oF) if (!eF.TryGetValue(kv.Key, out var n) || n != kv.Value) return false;
            return true;
        }

        /// <summary>Token-boundary check that a normalized statement references <c>this.&lt;id&gt;</c> (so id
        /// "button1" does not match "button10").</summary>
        private static bool RefsIdToken(string normalized, string id)
        {
            string pat = "this." + id;
            int idx = 0;
            while ((idx = normalized.IndexOf(pat, idx, StringComparison.Ordinal)) >= 0)
            {
                // the char BEFORE "this" must not be an identifier char (so it's the `this` keyword, not a
                // suffix like `my_this`), and the char AFTER the id must not be one either (button1 ≠ button10).
                char before = idx > 0 ? normalized[idx - 1] : ' ';
                int after = idx + pat.Length;
                char c = after < normalized.Length ? normalized[after] : ' ';
                bool beforeOk = !(char.IsLetterOrDigit(before) || before == '_');
                bool afterOk = !(char.IsLetterOrDigit(c) || c == '_');
                if (beforeOk && afterOk) return true;
                idx = after;
            }
            return false;
        }

        private static (int s, int e) LineRange(string src, int spanStart, int spanEnd)
        {
            int start = src.LastIndexOf('\n', Math.Max(0, spanStart - 1)) + 1;
            int nl = src.IndexOf('\n', spanEnd);
            int end = nl < 0 ? src.Length : nl + 1;
            return (start, end);
        }

        // ---- helpers (own copies — the proven property/event editors stay untouched, §6.5) ----

        private static ClassDeclarationSyntax? FindClassWithIC(SyntaxNode root)
        {
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
                if (cls.Members.OfType<MethodDeclarationSyntax>().Any(m => m.Identifier.Text == "InitializeComponent"))
                    return cls;
            return null;
        }

        private static HashSet<string> GatherFieldNames(ClassDeclarationSyntax cls)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
                foreach (var v in f.Declaration.Variables)
                    set.Add(v.Identifier.Text);
            return set;
        }

        private static List<string> FieldDeclNames(SyntaxNode root)
        {
            var cls = FindClassWithIC(root);
            var list = new List<string>();
            if (cls != null)
                foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var v in f.Declaration.Variables)
                        list.Add(v.Identifier.Text);
            return list;
        }

        private static List<string> InitStatements(SyntaxNode root)
        {
            var cls = FindClassWithIC(root);
            var init = cls?.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(m => m.Identifier.Text == "InitializeComponent");
            var list = new List<string>();
            if (init?.Body != null)
                foreach (var st in init.Body.Statements)
                    list.Add(NormalizeStmt(st.ToString()));
            return list;
        }

        private static string ShortName(string fqn)
        {
            int i = fqn.LastIndexOf('.');
            return i < 0 ? fqn : fqn.Substring(i + 1);
        }

        private static string UniqueName(string baseName, HashSet<string> names)
        {
            for (int i = 1; i < 100000; i++)
            {
                string cand = baseName + i;
                if (!names.Contains(cand)) return cand;
            }
            return baseName + "_x";
        }

        private static int CountAddTo(MethodDeclarationSyntax init, string parent, bool isRoot)
        {
            int n = 0;
            foreach (var st in init.Body!.Statements)
            {
                if (st is ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }
                    && inv.Expression is MemberAccessExpressionSyntax ma && ma.Name.Identifier.Text == "Add")
                {
                    var chain = Flatten(ma.Expression); // the `X.Controls` before `.Add`
                    bool match = isRoot ? (chain.Count == 1 && chain[0] == "Controls")
                                        : (chain.Count == 2 && chain[0] == parent && chain[1] == "Controls");
                    if (match) n++;
                }
            }
            return n;
        }

        private static int InitInsertPos(string src, MethodDeclarationSyntax init)
        {
            StatementSyntax? anchor = null;
            foreach (var st in init.Body!.Statements) if (!IsLayoutCall(st)) anchor = st;
            anchor ??= init.Body.Statements.FirstOrDefault();
            if (anchor == null)
            {
                int ob = init.Body.OpenBraceToken.Span.End;
                int nlx = src.IndexOf('\n', ob);
                return nlx < 0 ? ob : nlx + 1;
            }
            int afterSemi = anchor.Span.End;
            int nlIdx = src.IndexOf('\n', afterSemi);
            return nlIdx < 0 ? src.Length : nlIdx + 1;
        }

        private static bool IsLayoutCall(StatementSyntax st)
        {
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            string? n = inv.Expression switch
            {
                MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
                IdentifierNameSyntax id => id.Identifier.Text,
                _ => null,
            };
            return n is "SuspendLayout" or "ResumeLayout" or "PerformLayout";
        }

        private static string? InsertField(string text, string fieldLine)
        {
            var root = CSharpSyntaxTree.ParseText(text).GetRoot();
            var cls = FindClassWithIC(root);
            if (cls == null) return null;
            var fields = cls.Members.OfType<FieldDeclarationSyntax>().ToList();
            int pos;
            if (fields.Count > 0)
            {
                int afterSemi = fields[fields.Count - 1].Span.End;
                int nlIdx = text.IndexOf('\n', afterSemi);
                pos = nlIdx < 0 ? text.Length : nlIdx + 1;
            }
            else
            {
                int cb = cls.CloseBraceToken.SpanStart;
                pos = text.LastIndexOf('\n', Math.Max(0, cb - 1)) + 1;
            }
            return text.Substring(0, pos) + fieldLine + text.Substring(pos);
        }

        private static string BodyIndent(string src, MethodDeclarationSyntax init)
        {
            var first = init.Body!.Statements.FirstOrDefault();
            if (first != null) return LeadingIndent(src, first.SpanStart);
            return LeadingIndent(src, init.SpanStart) + "    ";
        }

        private static string FieldIndent(string src, ClassDeclarationSyntax cls)
        {
            var f = cls.Members.OfType<FieldDeclarationSyntax>().LastOrDefault();
            if (f != null) return LeadingIndent(src, f.SpanStart);
            var m = cls.Members.FirstOrDefault();
            if (m != null) return LeadingIndent(src, m.SpanStart);
            return LeadingIndent(src, cls.SpanStart) + "    ";
        }

        private static string LeadingIndent(string text, int pos)
        {
            int lineStart = text.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;
            int i = lineStart;
            while (i < text.Length && (text[i] == ' ' || text[i] == '\t')) i++;
            return text.Substring(lineStart, i - lineStart);
        }

        private static string NormalizeStmt(string s) => new string(s.Where(c => !char.IsWhiteSpace(c)).ToArray());

        private static Dictionary<string, int> Counter(IEnumerable<string> items)
        {
            var d = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var i in items) d[i] = d.TryGetValue(i, out var c) ? c + 1 : 1;
            return d;
        }

        private static IEnumerable<string> MultisetSubtract(List<string> from, List<string> remove)
        {
            var rem = Counter(remove);
            foreach (var s in from)
            {
                if (rem.TryGetValue(s, out var c) && c > 0) { rem[s] = c - 1; continue; }
                yield return s;
            }
        }

        public static bool IsValidIdentifier(string s)
        {
            if (string.IsNullOrEmpty(s)) return false;
            if (!(char.IsLetter(s[0]) || s[0] == '_')) return false;
            for (int i = 1; i < s.Length; i++)
                if (!(char.IsLetterOrDigit(s[i]) || s[i] == '_')) return false;
            return true;
        }

        private static List<string> Flatten(ExpressionSyntax expr)
        {
            var names = new List<string>();
            void Walk(ExpressionSyntax e)
            {
                switch (e)
                {
                    case MemberAccessExpressionSyntax m: Walk(m.Expression); names.Add(m.Name.Identifier.Text); break;
                    case ThisExpressionSyntax: break;
                    case IdentifierNameSyntax id: names.Add(id.Identifier.Text); break;
                    case ParenthesizedExpressionSyntax p: Walk(p.Expression); break;
                    default: names.Add("?" + e.Kind()); break;
                }
            }
            Walk(expr);
            return names;
        }
    }
}
