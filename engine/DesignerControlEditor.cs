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
    /// generated name. Null on reject. <see cref="TypeName"/> / <see cref="X"/> / <see cref="Y"/> let the net48
    /// compiled-preview host mirror the paste by live-instantiating the clone (the net9 splice only produces the
    /// text; the compiled instance needs the type + location to add it live). <see cref="X"/>/<see cref="Y"/> are
    /// the nudged Location, or -1 when the clip has no representable integer Location.</summary>
    public sealed class ControlPasteResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string? NewText { get; init; }
        public string Name { get; init; } = "";
        public string TypeName { get; init; } = "";
        public int X { get; init; } = -1;
        public int Y { get; init; } = -1;
        /// <summary>Named dependencies the target form lacks or declares with a different type. A failed paste
        /// returns these explicitly so the UI can explain what must be added instead of reporting generic unsafe data.</summary>
        public List<string> MissingDependencies { get; init; } = new();
    }

    /// <summary>Result of <see cref="DesignerControlEditor.MoveZOrder"/> (Bring to Front / Send to Back) or
    /// <see cref="DesignerControlEditor.MoveTabPage"/> (one position left/right): the reordered .Designer.cs text.
    /// <see cref="NewText"/> equals the input for an edge no-op; null on reject.</summary>
    public sealed class ControlReorderResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string? NewText { get; init; }
    }

    /// <summary>One toolbox-eligible control type surfaced to the palette (auto-population): its short
    /// key (used as the AddControl <c>controlTypeKey</c>), assembly-qualified-ish full name (display/grouping
    /// only — never trusted to reach <c>new</c>; AddControl re-resolves the key against the enumerated set),
    /// VS-style category, and whether it came from the resolved project assembly vs the framework.</summary>
    public sealed class ToolboxItemInfo
    {
        public string Name { get; init; } = "";
        public string Fqn { get; init; } = "";
        public string Category { get; init; } = "";
        public bool FromProject { get; init; }
        /// <summary>The control's 16×16 toolbox bitmap (the icon VS shows in the palette) as a base64 PNG, or
        /// null when none is embedded / extraction failed. Sourced from the type's own <c>[ToolboxBitmap]</c>
        /// (the framework's shipped icon for that control) — no external asset. Display only.</summary>
        public string? IconPng { get; init; }
        /// <summary>True for a NON-visual component (Timer/ToolTip/ErrorProvider/dialogs…) — added via AddComponent
        /// (a bare <c>new T()</c> that lands in the component tray) rather than AddControl (which also emits
        /// Location/Size/Controls.Add). Lets the palette route the add to the right safe-save path.</summary>
        public bool IsComponent { get; init; }
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
        public string AssemblyPath { get; init; } = "";
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
    /// untouched. NO graph load / interpreter change is needed: the generated `this.X = new T();` /
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
            ["Button"] = "Common Controls",
            ["CheckBox"] = "Common Controls",
            ["CheckedListBox"] = "Common Controls",
            ["ComboBox"] = "Common Controls",
            ["DateTimePicker"] = "Common Controls",
            ["Label"] = "Common Controls",
            ["LinkLabel"] = "Common Controls",
            ["ListBox"] = "Common Controls",
            ["ListView"] = "Common Controls",
            ["MaskedTextBox"] = "Common Controls",
            ["MonthCalendar"] = "Common Controls",
            ["NumericUpDown"] = "Common Controls",
            ["PictureBox"] = "Common Controls",
            ["ProgressBar"] = "Common Controls",
            ["RadioButton"] = "Common Controls",
            ["RichTextBox"] = "Common Controls",
            ["TextBox"] = "Common Controls",
            ["TreeView"] = "Common Controls",
            ["DomainUpDown"] = "Common Controls",
            ["TrackBar"] = "Common Controls",
            ["WebBrowser"] = "Common Controls",
            ["PropertyGrid"] = "Common Controls",
            ["HScrollBar"] = "Common Controls",
            ["VScrollBar"] = "Common Controls",
            // Containers
            ["FlowLayoutPanel"] = "Containers",
            ["GroupBox"] = "Containers",
            ["Panel"] = "Containers",
            ["SplitContainer"] = "Containers",
            ["TabControl"] = "Containers",
            ["TableLayoutPanel"] = "Containers",
            ["Splitter"] = "Containers",
            // Menus & Toolbars
            ["MenuStrip"] = "Menus & Toolbars",
            ["StatusStrip"] = "Menus & Toolbars",
            ["ToolStrip"] = "Menus & Toolbars",
            ["ToolStripContainer"] = "Menus & Toolbars",
            ["ToolStripPanel"] = "Menus & Toolbars",
            // Data / Printing
            ["DataGridView"] = "Data",
            ["BindingNavigator"] = "Data",
            ["PrintPreviewControl"] = "Printing",
        };

        private static string CategoryFor(string name) => Category.TryGetValue(name, out var c) ? c : DefaultCategory;

        // Lazily-discovered, process-stable framework toolbox controls (strings only — never live Type objects,
        // per reload-safety; the set is re-derivable and AddControl re-resolves the key against it).
        private static List<ToolboxItemInfo>? _framework;

        /// <summary>Reflect <c>System.Windows.Forms</c> for every toolbox-eligible visual control: public,
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
                list.Add(new ToolboxItemInfo { Name = t.Name, Fqn = t.FullName!, Category = CategoryFor(t.Name), FromProject = false, IconPng = ToolboxIconPng(t) });
            }
            // dedup with the SAME comparer ResolveSpec matches with (OrdinalIgnoreCase) so resolution is
            // deterministic even if the framework ever ships two control types differing only in case.
            _framework = list.GroupBy(i => i.Name, StringComparer.OrdinalIgnoreCase).Select(g => g.First())
                             .OrderBy(i => i.Name, StringComparer.Ordinal).ToList();
            return _framework;
        }

        /// <summary>The toolbox-eligibility predicate, shared by framework discovery and project-assembly
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

        /// <summary>Build a "Project Controls" palette item for a project-assembly control type.</summary>
        public static ToolboxItemInfo MakeProjectInfo(Type t) =>
            new() { Name = t.Name, Fqn = t.FullName!, Category = "Project Controls", FromProject = true, IconPng = ToolboxIconPng(t) };

        /// <summary>The control type's 16×16 toolbox bitmap (the icon VS shows in the palette) as a base64 PNG,
        /// or null when none is embedded / extraction fails. Read via the type's own <c>[ToolboxBitmap]</c> —
        /// this resolves the bitmap the framework ships for that control (same source VS uses), so no external
        /// icon asset is needed. Fully guarded: any failure degrades to no icon, never throws.</summary>
        public static string? ToolboxIconPng(Type t)
        {
            try
            {
                var tba = (System.Drawing.ToolboxBitmapAttribute?)
                    System.ComponentModel.TypeDescriptor.GetAttributes(t)[typeof(System.Drawing.ToolboxBitmapAttribute)];
                using var img = tba?.GetImage(t, false); // small (16×16) variant
                if (img == null) return null;
                using var bmp = new System.Drawing.Bitmap(img);
                using var ms = new System.IO.MemoryStream();
                bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
                return Convert.ToBase64String(ms.ToArray());
            }
            catch { return null; }
        }

        // Lazily-discovered, process-stable framework NON-visual components (Timer/ToolTip/ErrorProvider/ImageList/
        // BindingSource/NotifyIcon/HelpProvider + the common dialogs). Strings only (reload-safety).
        private static List<ToolboxItemInfo>? _components;

        /// <summary>Reflect <c>System.Windows.Forms</c> for every toolbox-eligible NON-visual component (Components/
        /// Dialogs): public, concrete, IComponent but NOT a Control, parameterless- or IContainer-constructible, not
        /// <c>[ToolboxItem(false)]</c>/<c>[DesignTimeVisible(false)]</c>. CommonDialog-derived → "Dialogs", else
        /// "Components". These are added via <see cref="AddComponent"/> (a bare <c>new T()</c> that lands in the tray).</summary>
        public static List<ToolboxItemInfo> DiscoverComponents()
        {
            if (_components != null) return _components;
            var list = new List<ToolboxItemInfo>();
            Type[] types;
            try { types = typeof(System.Windows.Forms.Control).Assembly.GetTypes(); }
            catch (System.Reflection.ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray()!; }
            foreach (var t in types)
            {
                if (t == null || !IsEligibleToolboxComponent(t)) continue;
                bool isDialog = typeof(System.Windows.Forms.CommonDialog).IsAssignableFrom(t);
                list.Add(new ToolboxItemInfo
                {
                    Name = t.Name,
                    Fqn = t.FullName!,
                    Category = isDialog ? "Dialogs" : "Components",
                    FromProject = false,
                    IconPng = ToolboxIconPng(t),
                    IsComponent = true,
                });
            }
            _components = list.GroupBy(i => i.Name, StringComparer.OrdinalIgnoreCase).Select(g => g.First())
                              .OrderBy(i => i.Name, StringComparer.Ordinal).ToList();
            return _components;
        }

        /// <summary>Toolbox-eligibility for a NON-visual component: public, concrete, IComponent but NOT Control,
        /// constructible parameterless or with an IContainer (the two shapes the designer uses), not
        /// <c>[ToolboxItem(false)]</c>/<c>[DesignTimeVisible(false)]</c>, and not a base/utility type.</summary>
        public static bool IsEligibleToolboxComponent(Type t)
        {
            if (!t.IsPublic || !t.IsClass || t.IsAbstract || t.IsGenericTypeDefinition || t.IsNested) return false;
            if (!typeof(System.ComponentModel.IComponent).IsAssignableFrom(t)) return false;
            if (typeof(System.Windows.Forms.Control).IsAssignableFrom(t)) return false; // visual controls go the AddControl path
            // collection sub-items belong to a parent's collection editor (ToolStrip.Items, DataGridView.Columns), NOT
            // the form/tray — they aren't standalone toolbox components, so drop them.
            if (typeof(System.Windows.Forms.ToolStripItem).IsAssignableFrom(t)) return false;
            if (typeof(System.Windows.Forms.DataGridViewColumn).IsAssignableFrom(t)) return false;
            // AddComponent emits `new T()`, so a parameterless ctor is REQUIRED (a ctor(IContainer)-only type would
            // produce non-compiling source). All the offered components/dialogs have one; the container ctor, when
            // present, is preferred at emit time for disposal fidelity.
            if (t.GetConstructor(Type.EmptyTypes) == null) return false;
            if (IsToolboxDisabled(t) || IsDesignTimeInvisible(t)) return false;
            if (BaseClassDenylist.Contains(t.Name)) return false;
            if (string.IsNullOrEmpty(t.FullName) || t.FullName!.IndexOf('+') >= 0) return false;
            return true;
        }

        /// <summary>Add a NON-visual component (Timer/ToolTip/dialog…) to a .Designer.cs as a MINIMAL text edit: a
        /// new field declaration + a single <c>this.X = new T();</c> (NO Location/Size/Controls.Add — it lives in the
        /// component tray, named after its field). The type must be in the discovered component set (no arbitrary
        /// type name reaches <c>new</c>); safety reuses <see cref="OnlyControlAdded"/> (original statements preserved,
        /// every added statement references the new component, exactly one field added).</summary>
        public static ControlAddResult AddComponent(string src, string componentTypeKey)
        {
            var info = DiscoverComponents().FirstOrDefault(i =>
                string.Equals(i.Name, componentTypeKey, StringComparison.OrdinalIgnoreCase)
                || string.Equals(i.Fqn, componentTypeKey, StringComparison.Ordinal));
            if (info == null)
                return new ControlAddResult { Safe = false, Reason = "unknown component type: " + componentTypeKey };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null)
                return new ControlAddResult { Safe = false, Reason = "InitializeComponent not found" };

            var names = GatherFieldNames(cls);
            string name = UniqueName(VsBaseName(info.Fqn), names);
            if (!IsValidIdentifier(name))
                return new ControlAddResult { Safe = false, Reason = "could not generate a valid component name" };

            string nl = src.Contains("\r\n") ? "\r\n" : "\n";
            string indent = BodyIndent(src, init);
            // VS-fidelity/disposal: site the component in the form's `components` container when the form has an
            // INITIALIZED one and the type accepts an IContainer ctor — so components.Dispose() disposes it. Else a
            // bare new T() (still tray-representable; the interpreter ignores the ctor arg either way).
            var compType = typeof(System.Windows.Forms.Control).Assembly.GetType(info.Fqn);
            bool useContainer = names.Contains("components")
                && System.Text.RegularExpressions.Regex.IsMatch(src, @"this\s*\.\s*components\s*=\s*new\b")
                && compType?.GetConstructor(new[] { typeof(System.ComponentModel.IContainer) }) != null;
            string stmt = indent + $"this.{name} = new {info.Fqn}({(useContainer ? "this.components" : "")});" + nl;

            int insertPos = InitInsertPos(src, init);
            string withStmts = src.Substring(0, insertPos) + stmt + src.Substring(insertPos);

            string fieldLine = FieldIndent(src, cls) + $"private {info.Fqn} {name};" + nl;
            string? finalText = InsertField(withStmts, fieldLine);
            if (finalText == null)
                return new ControlAddResult { Safe = false, Reason = "could not place the field declaration" };

            bool parseOk = !CSharpSyntaxTree.ParseText(finalText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = OnlyControlAdded(src, finalText, name);
            if (!parseOk || !gateOk)
                return new ControlAddResult { Safe = false, Name = name, Reason = !parseOk ? "added text has syntax errors" : "edit changed more than the new component" };
            return new ControlAddResult { Safe = true, Name = name, NewText = finalText };
        }

        /// <summary>Broader eligibility for the "Choose Toolbox Items" LISTING dialog: a public, concrete,
        /// parameterless-ctor type that is a Control OR an IComponent (so non-visual components — Timer, the
        /// dialogs, providers — are listed like in VS), excluding Forms / ToolStripDropDown menus, the
        /// base/utility/editing-helper types, and anything the author marked hidden from the designer
        /// (<c>[ToolboxItem(false)]</c> / <c>[DesignTimeVisible(false)]</c>). Listing only — NEVER gates
        /// construction (AddControl has its own gate).</summary>
        public static bool IsToolboxDialogEligible(Type t)
        {
            if (!t.IsPublic || !t.IsClass || t.IsAbstract || t.IsGenericTypeDefinition || t.IsNested) return false;
            if (!typeof(System.Windows.Forms.Control).IsAssignableFrom(t) && !typeof(System.ComponentModel.IComponent).IsAssignableFrom(t)) return false;
            if (typeof(System.Windows.Forms.Form).IsAssignableFrom(t) || typeof(System.Windows.Forms.ToolStripDropDown).IsAssignableFrom(t)) return false;
            if (t.GetConstructor(Type.EmptyTypes) == null) return false;
            if (IsToolboxDisabled(t) || IsDesignTimeInvisible(t)) return false; // respect [ToolboxItem(false)] AND [DesignTimeVisible(false)], like VS
            if (BaseClassDenylist.Contains(t.Name) || t.Name.EndsWith("EditingControl", StringComparison.Ordinal)) return false;
            if (string.IsNullOrEmpty(t.FullName) || t.FullName!.IndexOf('+') >= 0) return false;
            return true;
        }

        /// <summary>Build a Choose-Items row: short name, namespace, and the type's assembly simple name,
        /// version and on-disk directory (the .NET equivalent of VS's GAC "Directory" column). Strings only.</summary>
        public static ToolboxCandidate MakeCandidate(Type t, bool fromProject)
        {
            var an = t.Assembly.GetName();
            string location = "";
            string dir = "";
            try
            {
                // OriginOf, not Assembly.Location: a scanned user assembly is loaded from a private in-memory copy so
                // it never pins the user's build output, and such an assembly reports an EMPTY Location — which would
                // blank out this dialog's path/Directory columns. Framework assemblies still answer with Location.
                location = ControlLoadContext.OriginOf(t.Assembly);
                dir = string.IsNullOrEmpty(location) ? "" : (System.IO.Path.GetDirectoryName(location) ?? "");
            }
            catch { /* dynamic / no location */ }
            return new ToolboxCandidate
            {
                Name = t.Name,
                Namespace = t.Namespace ?? "",
                AssemblyName = an.Name ?? "",
                Version = an.Version?.ToString() ?? "",
                Directory = dir,
                FromProject = fromProject,
                AssemblyPath = location,
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
            // NOT added here: System.IO.FileSystem.Watcher / System.ComponentModel.EventBasedAsync. Listing
            // FileSystemWatcher and BackgroundWorker is only half the job — a Choose-Items row carries no
            // is-component flag, so the toolbox would offer them as draggable CONTROLS and adding one would fail as an
            // unknown control type. They belong here together with a component-aware add path.
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

        /// <summary>The auto-populated toolbox palette: curated common controls keep their VS sizes, the
        /// rest of the framework's visual controls are discovered by reflection. One entry per short name.</summary>
        public static IReadOnlyList<ToolboxItemInfo> ToolboxItems => DiscoverFramework();

        /// <summary>The toolbox's control type keys (e.g. "Button", "Label", …) — back-compat for ListControlTypes.</summary>
        public static IReadOnlyList<string> ControlTypes => ToolboxItems.Select(i => i.Name).ToList();

        /// <summary>Resolve a requested toolbox key to an emit spec. Curated common controls keep their VS sizes
        /// and Text-defaulting; any other key is matched against the discovered framework set, then the supplied
        /// project-control set by Fqn or short name — the ONLY ways an arbitrary type name can
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

        /// <param name="autoScaleDimensions">The rendered form's live CurrentAutoScaleDimensions as "6F, 13F".
        /// Written into the form's block on the first drop when the designer file carries no pair yet — the same
        /// moment Visual Studio writes it. Ignored unless it matches the exact literal shape.</param>
        public static ControlAddResult AddControl(string src, string parentId, string controlTypeKey,
            IReadOnlyList<ToolboxItemInfo>? projectControls = null, int? locX = null, int? locY = null,
            string? autoScaleDimensions = null)
        {
            var spec = ResolveSpec(controlTypeKey, projectControls);
            if (spec == null)
                return new ControlAddResult { Safe = false, Reason = "unknown control type: " + controlTypeKey };

            bool parentRoot = parentId is "this" or "";
            if (!parentRoot && !IsValidIdentifier(parentId))
                return new ControlAddResult { Safe = false, Reason = "invalid parent id: " + parentId };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null)
                return new ControlAddResult { Safe = false, Reason = "InitializeComponent not found" };

            var names = GatherFieldNames(cls);
            if (!parentRoot && !names.Contains(parentId))
                return new ControlAddResult { Safe = false, Reason = "unknown parent: " + parentId };

            string baseName = VsBaseName(spec.Fqn);
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

            // Emit into Visual Studio's own shape: constructors as one leading run, then a commented property block
            // per component (children before their parent), then the parent's block carrying Controls.Add — newest
            // FIRST, which is what puts a freshly dropped control on top of the z-order instead of underneath.
            var properties = new StringBuilder();
            void P(string s) { properties.Append(indent).Append(s).Append(nl); }
            P("// ");
            P("// " + name);
            P("// ");
            bool autoSize = AutoSizedByDesigner(spec.Fqn);
            if (autoSize) P($"this.{name}.AutoSize = true;");
            P($"this.{name}.Location = new System.Drawing.Point({x}, {y});");
            P($"this.{name}.Name = \"{name}\";");
            if (spec.W > 0 && spec.H > 0) P($"this.{name}.Size = new System.Drawing.Size({spec.W}, {spec.H});");
            P($"this.{name}.TabIndex = {childCount};");
            if (spec.SetText) P($"this.{name}.Text = \"{name}\";");
            if (HasVisualStyleBackColor(spec.Fqn)) P($"this.{name}.UseVisualStyleBackColor = true;");

            var layout = InitLayout(src, init, cls, names, parentId, parentRoot);
            var inserts = new List<(int Pos, int Seq, string Text)>
            {
                (layout.CtorPos, 0, indent + $"this.{name} = new {spec.Fqn}();" + nl),
                (layout.PropertiesPos, 2, properties.ToString()),
                (layout.AddPos, 3, indent + $"{addTarget}.Controls.Add(this.{name});" + nl),
            };
            // A form that has never carried a control yet (this extension's own Add → Form output) gains the layout
            // scaffold and the form's own block header on this first drop, exactly as Visual Studio would write it.
            var extras = new List<string>();
            if (!layout.HasSuspendLayout)
            {
                extras.Add("this.SuspendLayout();");
                extras.Add("this.ResumeLayout(false);");
                inserts.Add((layout.CtorPos, 1, indent + "this.SuspendLayout();" + nl)); // after the ctor run
                inserts.Add((layout.ResumePos, 4, indent + "this.ResumeLayout(false);" + nl));
                if (layout.RootBlockPos >= 0)
                {
                    inserts.Add((layout.RootBlockPos, 5,
                        indent + "// " + nl + indent + "// " + cls.Identifier.Text + nl + indent + "// " + nl));
                }
            }
            // ResumeLayout(false) performs no layout pass, so Visual Studio follows it with PerformLayout() as soon
            // as the form holds a control that sizes itself. Added once, whenever the first such control arrives.
            if (autoSize && !init.Body.Statements.Any(st => IsLayoutCall(st) && st.ToString().Contains("PerformLayout")))
            {
                extras.Add("this.PerformLayout();");
                inserts.Add((layout.ResumePos, 8, indent + "this.PerformLayout();" + nl));
            }
            // The form's own serialized members, which Visual Studio writes as soon as it serializes a form and
            // this splice has no other occasion to add. `Name` is the class name; the scale pair comes from the
            // LIVE form the caller just rendered — never a constant, which would be wrong on any target whose
            // default font is not the one this engine runs with.
            if (parentRoot && !layout.RootAssigns("Name"))
            {
                string stmt = $"this.Name = \"{cls.Identifier.Text}\";";
                extras.Add(stmt);
                inserts.Add((BlockOrderPos(src, layout.RootBlock, "Name", layout.BodyEnd), 6, indent + stmt + nl));
            }
            if (parentRoot && !layout.RootAssigns("AutoScaleDimensions") && IsAutoScalePair(autoScaleDimensions))
            {
                string stmt = $"this.AutoScaleDimensions = new System.Drawing.SizeF({autoScaleDimensions});";
                extras.Add(stmt);
                inserts.Add((BlockOrderPos(src, layout.RootBlock, "AutoScaleDimensions", layout.BodyEnd), 7, indent + stmt + nl));
            }
            string withStmts = ApplyInserts(src, inserts);

            string fieldLine = FieldIndent(src, cls) + $"private {spec.Fqn} {name};" + nl;
            string? finalText = InsertField(withStmts, fieldLine);
            if (finalText == null)
                return new ControlAddResult { Safe = false, Reason = "could not place the field declaration" };

            bool parseOk = !CSharpSyntaxTree.ParseText(finalText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = OnlyControlAdded(src, finalText, name, extras);
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

        /// <summary>
        /// Add a NEW empty tab page to a tab host (WinForms TabControl / DevExpress XtraTabControl). Emits a field +
        /// <c>this.&lt;page&gt; = new &lt;pageTypeFqn&gt;();</c> + Name/Text + <c>this.&lt;host&gt;.TabPages.Add(this.&lt;page&gt;);</c>
        /// (a plain <c>.Add</c> appends after any existing <c>AddRange</c>). <paramref name="pageTypeFqn"/> is the tab
        /// page type (the host derives it from an existing page's type) — validated as a bare dotted name so it can't
        /// inject a member. Safety reuses <see cref="OnlyControlAdded"/> (originals preserved, added statements
        /// reference only the new page, exactly one new field/member).
        /// </summary>
        public static ControlAddResult AddTabPage(string src, string hostId, string pageTypeFqn)
        {
            if (!IsValidIdentifier(hostId)) return new ControlAddResult { Safe = false, Reason = "invalid tab host id: " + hostId };
            if (!IsValidTypeName(pageTypeFqn)) return new ControlAddResult { Safe = false, Reason = "invalid tab page type: " + pageTypeFqn };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return new ControlAddResult { Safe = false, Reason = "InitializeComponent not found" };

            var names = GatherFieldNames(cls);
            if (!names.Contains(hostId)) return new ControlAddResult { Safe = false, Reason = "unknown tab host: " + hostId };

            string baseName = VsBaseName(pageTypeFqn);
            if (!IsValidIdentifier(baseName)) baseName = "tabPage";
            string name = UniqueName(baseName, names);
            if (!IsValidIdentifier(name)) return new ControlAddResult { Safe = false, Reason = "could not generate a valid tab name" };

            string nl = src.Contains("\r\n") ? "\r\n" : "\n";
            string indent = BodyIndent(src, init);
            var sb = new StringBuilder();
            void S(string s) { sb.Append(indent).Append(s).Append(nl); }
            S($"this.{name} = new {pageTypeFqn}();");
            S($"this.{name}.Name = \"{name}\";");
            S($"this.{name}.Text = \"{name}\";");
            S($"this.{hostId}.TabPages.Add(this.{name});");

            int insertPos = InitInsertPos(src, init);
            string withStmts = src.Substring(0, insertPos) + sb.ToString() + src.Substring(insertPos);

            string fieldLine = FieldIndent(src, cls) + $"private {pageTypeFqn} {name};" + nl;
            string? finalText = InsertField(withStmts, fieldLine);
            if (finalText == null) return new ControlAddResult { Safe = false, Reason = "could not place the field declaration" };

            bool parseOk = !CSharpSyntaxTree.ParseText(finalText).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = OnlyControlAdded(src, finalText, name);
            if (!parseOk || !gateOk)
                return new ControlAddResult { Safe = false, Name = name, Reason = !parseOk ? "added text has syntax errors" : "edit changed more than the new tab" };
            return new ControlAddResult { Safe = true, Name = name, NewText = finalText };
        }

        /// <summary>safe-save gate: every ORIGINAL InitializeComponent statement is preserved unchanged, every EXTRA
        /// statement references only the new control, exactly ONE field declaration was added (the new one),
        /// and all original fields are preserved.</summary>
        /// <param name="plannedExtras">Statements the caller intends to add that do NOT mention the new control —
        /// the layout scaffold and the form's own `Name` / `AutoScaleDimensions`. Each is matched by exact
        /// (whitespace-free) text and admitted at most once, so this widens the gate by precisely the lines the
        /// engine itself composed and by nothing else.</param>
        public static bool OnlyControlAdded(string original, string edited, string name,
            IReadOnlyCollection<string>? plannedExtras = null)
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
            // OnlyControlRemoved — so a hand-injected "this.<name>_extra.X" can't slip past a substring match).
            // The ONE exception is the layout scaffold a first drop adds to a form that has none: an exact-text
            // match against three fixed statements, each allowed at most once, referencing nothing at all.
            var allowed = new HashSet<string>(StringComparer.Ordinal);
            foreach (var planned in plannedExtras ?? Array.Empty<string>()) allowed.Add(NormalizeStmt(planned));
            var admitted = new HashSet<string>(StringComparer.Ordinal);
            foreach (var extra in MultisetSubtract(eInit, oInit))
            {
                if (RefsIdToken(extra, name)) continue;
                if (allowed.Contains(extra) && admitted.Add(extra)) continue; // each at most once
                return false;
            }
            // Those statements only ever appear on a form that lacked them: never a second scaffold, Name, or scale.
            if (admitted.Any(a => oInit.Contains(a))) return false;

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
            var init = FormClassResolver.InitMethodOf(cls);
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
            // The control's `//`-`// name`-`//` block header goes with it; leaving it behind would litter the file
            // with headers naming controls that no longer exist (Visual Studio regenerates the method, so it has none).
            var headerRange = BlockHeaderRange(src, removeStmts, controlId);
            if (headerRange != null) ranges.Add(headerRange.Value);
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

        /// <summary>safe-save gate: the edit only REMOVED statements (no add/change), every removed statement
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

        // ---- remove an entire tab page (the page + its whole subtree) ----

        /// <summary>
        /// Remove tab page <paramref name="pageId"/> from tab host <paramref name="hostId"/>, deleting the page AND its
        /// ENTIRE subtree (every descendant control's field declaration + InitializeComponent statements) and detaching
        /// the page from the host's tab collection: a 1-arg <c>&lt;host&gt;.Controls.Add(this.&lt;page&gt;)</c> /
        /// <c>&lt;host&gt;.TabPages.Add(this.&lt;page&gt;)</c> is removed whole; an element inside a
        /// <c>&lt;host&gt;.TabPages.AddRange(new[]{…})</c> is TRIMMED (the whole AddRange goes only if the page was its
        /// sole element). Refuses (never risks a bad edit) when the subtree is referenced from OUTSIDE it (an
        /// extender/event/assignment whose receiver is not in the subtree), when a field decl mixes subtree + external
        /// fields, or when the parenting AddRange has a non-trivial (non-<c>this.&lt;id&gt;</c>) element. Verified by
        /// <see cref="OnlyTabSubtreeRemoved"/> (only subtree fields removed, no surviving statement references the
        /// subtree, at most the one trimmed AddRange changed).
        /// </summary>
        public static ControlRemoveResult RemoveTabPage(string src, string hostId, string pageId)
        {
            if (pageId is "this" or "") return new ControlRemoveResult { Safe = false, Reason = "cannot remove the root form" };
            if (!IsValidIdentifier(hostId)) return new ControlRemoveResult { Safe = false, Reason = "invalid tab host id: " + hostId };
            if (!IsValidIdentifier(pageId)) return new ControlRemoveResult { Safe = false, Reason = "invalid tab page id: " + pageId };
            if (pageId == hostId) return new ControlRemoveResult { Safe = false, Reason = "page and host are the same control" };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return new ControlRemoveResult { Safe = false, Reason = "InitializeComponent not found" };
            var names = GatherFieldNames(cls);
            if (!names.Contains(hostId)) return new ControlRemoveResult { Safe = false, Reason = "unknown tab host: " + hostId };
            if (!names.Contains(pageId)) return new ControlRemoveResult { Safe = false, Reason = "unknown tab page: " + pageId };

            // (1) the parenting statement — how the page attaches to the host (1-arg Add, or an element of an AddRange).
            StatementSyntax? parenting = null;
            bool parentingIsAddRange = false;
            foreach (var st in init.Body.Statements)
                if (IsTabAddOfHost(st, hostId, pageId)) { parenting = st; break; }
            if (parenting == null)
                foreach (var st in init.Body.Statements)
                    if (IsTabAddRangeOfHostContaining(st, hostId, pageId)) { parenting = st; parentingIsAddRange = true; break; }
            if (parenting == null)
                return new ControlRemoveResult { Safe = false, Reason = "page is not attached to host " + hostId + " (no Controls.Add / TabPages.Add[Range])" };

            // (2) the subtree closure — the page plus everything transitively Add/AddRange-ed under it.
            var closure = ComputeSubtreeClosure(init, pageId, names);

            // (3) classify every statement into whole-remove / AddRange-surgery / keep, refusing external entanglement.
            var wholeRemove = new List<StatementSyntax>();
            StatementSyntax? surgeryStmt = null;
            List<ExpressionSyntax>? surgeryTrim = null;
            foreach (var st in init.Body.Statements)
            {
                if (parentingIsAddRange && st == parenting)
                {
                    if (!TryPlanAddRangeSurgery(st, closure, out var trim, out bool removeWhole, out string? why))
                        return new ControlRemoveResult { Safe = false, Reason = why! };
                    if (removeWhole) wholeRemove.Add(st);
                    else { surgeryStmt = st; surgeryTrim = trim; }
                    continue;
                }
                var refs = ClosureRefs(st, closure);
                if (refs.Count == 0) continue;                       // untouched — references nothing in the subtree
                string? recvRoot = ReceiverRoot(st);
                if (recvRoot != null && closure.Contains(recvRoot)) { wholeRemove.Add(st); continue; } // internal to the subtree
                if (st == parenting) { wholeRemove.Add(st); continue; }                                 // the page's 1-arg parenting Add
                // the HOST referencing a to-be-deleted page — e.g. `this.<host>.SelectedTabPage = this.<page>` (the
                // active-tab selection). Safe to drop ONLY when the statement references NO surviving control besides
                // the host: dropping it removes just the deleted page's mention. If it ALSO names a surviving page (a
                // second TabPages.AddRange holding the other pages, a host method taking two pages, …), whole-removing
                // it would silently detach that survivor — so refuse instead.
                if (recvRoot == hostId)
                {
                    var otherRefs = ReferencedFieldIds(st, names);
                    otherRefs.Remove(hostId);
                    otherRefs.ExceptWith(closure);
                    if (otherRefs.Count == 0) { wholeRemove.Add(st); continue; }
                    return new ControlRemoveResult { Safe = false, Reason = "the host statement also references a control outside this tab (" + string.Join(", ", otherRefs) + ") — remove that reference first" };
                }
                // anything else that references the subtree from OUTSIDE it (a sibling / a form-level extender / an
                // event wired from elsewhere) → decline rather than risk a bad edit.
                return new ControlRemoveResult { Safe = false, Reason = "a control on this tab is referenced elsewhere (" + (recvRoot ?? "?") + ") — remove that reference first" };
            }

            // (4) field declarations — one per subtree control; refuse a decl that mixes a subtree + an external field.
            var fieldDecls = new List<FieldDeclarationSyntax>();
            foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
            {
                var vars = f.Declaration.Variables.Select(v => v.Identifier.Text).ToList();
                if (!vars.Any(closure.Contains)) continue;
                if (!vars.All(closure.Contains))
                    return new ControlRemoveResult { Safe = false, Reason = "a tab control shares a field declaration with a control outside the tab — cannot remove" };
                fieldDecls.Add(f);
            }

            // (5) apply the edits: the AddRange surgery (span replace) + whole-removes + field decls (line ranges),
            // descending by start offset so earlier splices don't shift later ones.
            var edits = new List<(int s, int e, string repl)>();
            if (surgeryStmt != null && surgeryTrim != null)
            {
                var initializer = FindArrayInitializer(surgeryStmt);
                if (initializer == null) return new ControlRemoveResult { Safe = false, Reason = "tab AddRange has no array initializer — cannot trim" };
                var newInit = initializer.RemoveNodes(surgeryTrim, SyntaxRemoveOptions.KeepNoTrivia)!;
                var newStmt = surgeryStmt.ReplaceNode(initializer, newInit);
                edits.Add((surgeryStmt.SpanStart, surgeryStmt.Span.End, newStmt.ToString()));
            }
            foreach (var st in wholeRemove) { var (s, e) = LineRange(src, st.SpanStart, st.Span.End); edits.Add((s, e, "")); }
            foreach (var f in fieldDecls) { var (s, e) = LineRange(src, f.SpanStart, f.Span.End); edits.Add((s, e, "")); }
            edits.Sort((a, b) => b.s.CompareTo(a.s));
            for (int i = 1; i < edits.Count; i++)
                if (edits[i].e > edits[i - 1].s) return new ControlRemoveResult { Safe = false, Reason = "overlapping edits — declined" };
            string text = src;
            foreach (var (s, e, repl) in edits) text = text.Substring(0, s) + repl + text.Substring(e);

            bool parseOk = !CSharpSyntaxTree.ParseText(text).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = OnlyTabSubtreeRemoved(src, text, closure);
            if (!parseOk || !gateOk)
                return new ControlRemoveResult { Safe = false, Reason = !parseOk ? "edited text has syntax errors" : "edit changed more than the tab subtree" };
            return new ControlRemoveResult { Safe = true, NewText = text };
        }

        /// <summary>
        /// Move one field-backed tab page a single position left/right in its host's source collection order.
        /// Supports the two canonical serializer shapes used by WinForms and vendor controls:
        /// <c>host.Controls/TabPages.Add(this.page)</c> and a fresh-array
        /// <c>host.Controls/TabPages.AddRange(new[]{ this.page, ... })</c>. The operation swaps only the two adjacent
        /// page-reference expressions, so it also works across an AddRange + later Add boundary without moving page
        /// initialization/property blocks or touching <c>TabIndex</c>. Non-trivial/duplicate attachment expressions
        /// fail closed. <see cref="OnlyTabPageMoved"/> independently proves the exact adjacent permutation.
        /// </summary>
        public static ControlReorderResult MoveTabPage(string src, string hostId, string pageId, bool left)
        {
            if (pageId is "this" or "") return new ControlReorderResult { Safe = false, Reason = "cannot reorder the root form" };
            if (!IsValidIdentifier(hostId)) return new ControlReorderResult { Safe = false, Reason = "invalid tab host id: " + hostId };
            if (!IsValidIdentifier(pageId)) return new ControlReorderResult { Safe = false, Reason = "invalid tab page id: " + pageId };
            if (hostId == pageId) return new ControlReorderResult { Safe = false, Reason = "page and host are the same control" };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            if (cls == null || FormClassResolver.InitMethodOf(cls)?.Body == null)
                return new ControlReorderResult { Safe = false, Reason = "InitializeComponent not found" };
            var names = GatherFieldNames(cls);
            if (!names.Contains(hostId)) return new ControlReorderResult { Safe = false, Reason = "unknown tab host: " + hostId };
            if (!names.Contains(pageId)) return new ControlReorderResult { Safe = false, Reason = "unknown tab page: " + pageId };

            if (!TryCollectTabAttachments(root, hostId, out var pages, out _, out _, out string? why))
                return new ControlReorderResult { Safe = false, Reason = why ?? "tab attachment order is not safely representable" };
            if (pages.Count == 0)
                return new ControlReorderResult { Safe = false, Reason = "tab host has no canonical Controls.Add / TabPages.Add[Range] pages" };
            if (pages.Select(p => p.PageId).Distinct(StringComparer.Ordinal).Count() != pages.Count)
                return new ControlReorderResult { Safe = false, Reason = "tab collection contains a duplicate page attachment" };

            int index = pages.FindIndex(p => p.PageId == pageId);
            if (index < 0)
                return new ControlReorderResult { Safe = false, Reason = "page is not attached to host " + hostId + " (no canonical Controls.Add / TabPages.Add[Range])" };
            int adjacent = left ? index - 1 : index + 1;
            if (adjacent < 0 || adjacent >= pages.Count)
                return new ControlReorderResult { Safe = true, NewText = src }; // already at the requested edge

            var mine = pages[index].PageExpression;
            var other = pages[adjacent].PageExpression;
            if (HasCommentTrivia(mine) || HasCommentTrivia(other))
                return new ControlReorderResult { Safe = false, Reason = "tab attachment has a comment on the page expression — reformat first" };

            string mineText = src.Substring(mine.SpanStart, mine.Span.Length);
            string otherText = src.Substring(other.SpanStart, other.Span.Length);
            var edits = new List<(int start, int end, string replacement)>
            {
                (mine.SpanStart, mine.Span.End, otherText),
                (other.SpanStart, other.Span.End, mineText),
            };
            edits.Sort((a, b) => b.start.CompareTo(a.start));
            string text = src;
            foreach (var edit in edits)
                text = text.Substring(0, edit.start) + edit.replacement + text.Substring(edit.end);

            bool parseOk = !CSharpSyntaxTree.ParseText(text).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            bool gateOk = parseOk && OnlyTabPageMoved(src, text, hostId, pageId, left);
            if (!parseOk || !gateOk)
                return new ControlReorderResult { Safe = false, Reason = !parseOk ? "reordered text has syntax errors" : "edit changed more than the adjacent tab order" };
            return new ControlReorderResult { Safe = true, NewText = text };
        }

        private sealed class TabAttachment
        {
            public StatementSyntax Statement { get; }
            public ExpressionSyntax PageExpression { get; }
            public string PageId { get; }

            public TabAttachment(StatementSyntax statement, ExpressionSyntax pageExpression, string pageId)
            {
                Statement = statement;
                PageExpression = pageExpression;
                PageId = pageId;
            }
        }

        /// <summary>Extract the canonical, execution-ordered page references attached to one host. Host collection
        /// statements are represented separately from every other InitializeComponent statement so the move gate can
        /// prove that only page identities changed inside otherwise-identical Add/AddRange shapes.</summary>
        private static bool TryCollectTabAttachments(SyntaxNode root, string hostId, out List<TabAttachment> pages,
            out List<string> nonTabStatements, out List<string> attachmentShapes, out string? why)
        {
            pages = new List<TabAttachment>();
            nonTabStatements = new List<string>();
            attachmentShapes = new List<string>();
            why = null;
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (init?.Body == null) { why = "InitializeComponent not found"; return false; }
            var names = cls == null ? new HashSet<string>(StringComparer.Ordinal) : GatherFieldNames(cls);

            foreach (var st in init.Body.Statements)
            {
                if (!TryGetTabCollectionInvocation(st, hostId, out var inv, out string method))
                {
                    nonTabStatements.Add(NormalizeStmt(st.ToString()));
                    continue;
                }

                var statementExpressions = new List<ExpressionSyntax>();
                if (method == "Add")
                {
                    if (inv!.ArgumentList.Arguments.Count != 1)
                    { why = "tab Add must have exactly one page argument"; return false; }
                    statementExpressions.Add(inv.ArgumentList.Arguments[0].Expression);
                }
                else
                {
                    var initializer = FindArrayInitializer(st);
                    if (initializer == null)
                    { why = "tab AddRange must use a fresh array initializer"; return false; }
                    statementExpressions.AddRange(initializer.Expressions);
                }

                foreach (var expression in statementExpressions)
                {
                    if (!TrySimpleFieldReference(expression, out string page) || !names.Contains(page))
                    { why = "tab collection contains a non-trivial or unknown page expression"; return false; }
                    pages.Add(new TabAttachment(st, expression, page));
                }
                attachmentShapes.Add(TabAttachmentShape(st, statementExpressions));
            }
            return true;
        }

        private static bool TryGetTabCollectionInvocation(StatementSyntax st, string hostId,
            out InvocationExpressionSyntax? invocation, out string method)
        {
            invocation = null; method = "";
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma) return false;
            method = ma.Name.Identifier.Text;
            if (method != "Add" && method != "AddRange") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count != 2 || chain[0] != hostId || (chain[1] != "Controls" && chain[1] != "TabPages")) return false;
            invocation = inv;
            return true;
        }

        private static bool TrySimpleFieldReference(ExpressionSyntax expression, out string id)
        {
            id = "";
            if (expression is IdentifierNameSyntax bare)
            {
                id = bare.Identifier.Text;
                return IsValidIdentifier(id);
            }
            if (expression is MemberAccessExpressionSyntax { Expression: ThisExpressionSyntax, Name: IdentifierNameSyntax member })
            {
                id = member.Identifier.Text;
                return IsValidIdentifier(id);
            }
            return false;
        }

        private static string TabAttachmentShape(StatementSyntax statement, IReadOnlyList<ExpressionSyntax> expressions)
        {
            var replaced = statement.ReplaceNodes(expressions, (original, _) =>
            {
                ExpressionSyntax placeholder = original is MemberAccessExpressionSyntax
                    ? SyntaxFactory.MemberAccessExpression(SyntaxKind.SimpleMemberAccessExpression,
                        SyntaxFactory.ThisExpression(), SyntaxFactory.IdentifierName("__TAB_PAGE__"))
                    : SyntaxFactory.IdentifierName("__TAB_PAGE__");
                return placeholder.WithTriviaFrom(original);
            });
            return NormalizeStmt(replaced.ToString());
        }

        private static bool HasCommentTrivia(SyntaxNode node) => node.DescendantTrivia(descendIntoTrivia: true).Any(t =>
            t.IsKind(SyntaxKind.SingleLineCommentTrivia)
            || t.IsKind(SyntaxKind.MultiLineCommentTrivia)
            || t.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia)
            || t.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia));

        /// <summary>Independent safety gate for a one-step tab move: non-tab statements, tab attachment shapes,
        /// fields, and class member count must be unchanged; the host's flattened page sequence must be exactly the
        /// original sequence with the requested page swapped with its immediate left/right neighbor.</summary>
        public static bool OnlyTabPageMoved(string original, string edited, string hostId, string pageId, bool left)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            if (!TryCollectTabAttachments(oRoot, hostId, out var oPages, out var oNon, out var oShapes, out _)
                || !TryCollectTabAttachments(eRoot, hostId, out var ePages, out var eNon, out var eShapes, out _)) return false;
            if (!oNon.SequenceEqual(eNon, StringComparer.Ordinal) || !oShapes.SequenceEqual(eShapes, StringComparer.Ordinal)) return false;
            if (ClassMemberCount(oRoot) != ClassMemberCount(eRoot)) return false;
            if (!MultisetEqual(FieldDeclNames(oRoot), FieldDeclNames(eRoot))) return false;

            var before = oPages.Select(p => p.PageId).ToList();
            var after = ePages.Select(p => p.PageId).ToList();
            if (before.Count != after.Count || before.Distinct(StringComparer.Ordinal).Count() != before.Count) return false;
            int index = before.IndexOf(pageId);
            int adjacent = left ? index - 1 : index + 1;
            if (index < 0 || adjacent < 0 || adjacent >= before.Count) return false;
            (before[index], before[adjacent]) = (before[adjacent], before[index]);
            return before.SequenceEqual(after, StringComparer.Ordinal);
        }

        /// <summary>True when <paramref name="st"/> is <c>this.&lt;host&gt;.(Controls|TabPages).Add(this.&lt;page&gt;)</c>
        /// (1-arg) — the page's whole-statement parenting under the host.</summary>
        private static bool IsTabAddOfHost(StatementSyntax st, string hostId, string pageId)
        {
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.Text != "Add") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count < 2 || chain[0] != hostId) return false;
            if (!chain.Contains("Controls") && !chain.Contains("TabPages")) return false;
            if (inv.ArgumentList.Arguments.Count != 1) return false;
            var arg = Flatten(inv.ArgumentList.Arguments[0].Expression);
            return arg.Count == 1 && arg[0] == pageId;
        }

        /// <summary>True when <paramref name="st"/> is <c>this.&lt;host&gt;.(Controls|TabPages).AddRange(new[]{…})</c>
        /// and the array initializer contains an element <c>this.&lt;page&gt;</c> — the page attaches via an AddRange.</summary>
        private static bool IsTabAddRangeOfHostContaining(StatementSyntax st, string hostId, string pageId)
        {
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.Text != "AddRange") return false;
            var chain = Flatten(ma.Expression);
            if (chain.Count < 2 || chain[0] != hostId) return false;
            if (!chain.Contains("Controls") && !chain.Contains("TabPages")) return false;
            var initializer = FindArrayInitializer(st);
            if (initializer == null) return false;
            foreach (var e in initializer.Expressions)
            { var f = Flatten(e); if (f.Count == 1 && f[0] == pageId) return true; }
            return false;
        }

        /// <summary>The array-initializer of a single-argument <c>X.AddRange(new T[]{…})</c> / <c>X.AddRange(new[]{…})</c>
        /// statement (explicit or implicit array creation), or null when the argument isn't a fresh array literal.</summary>
        private static InitializerExpressionSyntax? FindArrayInitializer(StatementSyntax st)
        {
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return null;
            if (inv.ArgumentList.Arguments.Count != 1) return null;
            return inv.ArgumentList.Arguments[0].Expression switch
            {
                ArrayCreationExpressionSyntax a => a.Initializer,
                ImplicitArrayCreationExpressionSyntax ia => ia.Initializer,
                _ => null,
            };
        }

        /// <summary>The transitive set of controls parented under <paramref name="pageId"/> (INCLUSIVE): BFS over
        /// InitializeComponent, following every <c>&lt;P&gt;.….Add(this.&lt;X&gt;)</c> (first arg — covers a 1-arg and a
        /// TableLayoutPanel 3-arg cell add) and <c>&lt;P&gt;.….AddRange(new[]{ this.&lt;X&gt;, … })</c> whose receiver is
        /// rooted at a control already in the set. Only ids that are real fields are included.</summary>
        private static HashSet<string> ComputeSubtreeClosure(MethodDeclarationSyntax init, string pageId, HashSet<string> names)
        {
            var closure = new HashSet<string>(StringComparer.Ordinal) { pageId };
            var work = new Queue<string>();
            work.Enqueue(pageId);
            var stmts = init.Body!.Statements;
            while (work.Count > 0)
            {
                string p = work.Dequeue();
                foreach (var st in stmts)
                    foreach (var child in ChildAddsUnder(st, p))
                        if (names.Contains(child) && closure.Add(child)) work.Enqueue(child);
            }
            return closure;
        }

        /// <summary>The child ids that statement <paramref name="st"/> adds into a sub-collection of
        /// <paramref name="parentId"/>: an <c>Add</c> whose receiver is rooted at parentId yields its FIRST
        /// <c>this.&lt;id&gt;</c> argument; an <c>AddRange</c> yields every <c>this.&lt;id&gt;</c> array element.</summary>
        private static IEnumerable<string> ChildAddsUnder(StatementSyntax st, string parentId)
        {
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) yield break;
            if (inv.Expression is not MemberAccessExpressionSyntax ma) yield break;
            string method = ma.Name.Identifier.Text;
            if (method != "Add" && method != "AddRange") yield break;
            var chain = Flatten(ma.Expression);
            if (chain.Count == 0 || chain[0] != parentId) yield break;
            if (method == "Add")
            {
                if (inv.ArgumentList.Arguments.Count >= 1)
                {
                    var f = Flatten(inv.ArgumentList.Arguments[0].Expression); // first arg = the control (1-arg or TLP 3-arg cell)
                    if (f.Count == 1) yield return f[0];
                }
                yield break;
            }
            var initializer = FindArrayInitializer(st);
            if (initializer == null) yield break;
            foreach (var e in initializer.Expressions)
            { var f = Flatten(e); if (f.Count == 1) yield return f[0]; }
        }

        /// <summary>The subtree ids that <paramref name="st"/> references anywhere — <c>this.&lt;id&gt;</c> OR a bare
        /// <c>&lt;id&gt;</c>. (Delegates to <see cref="ReferencedFieldIds"/>; the discovery side, Flatten, is
        /// this-agnostic, so the classifier must be too — else a bare-id statement is wrongly treated as untouched.)</summary>
        private static HashSet<string> ClosureRefs(StatementSyntax st, HashSet<string> closure) => ReferencedFieldIds(st, closure);

        /// <summary>Field ids (from <paramref name="universe"/>) that <paramref name="node"/> references — as either a
        /// THIS-qualified access (<c>this.&lt;id&gt;…</c>) OR a BARE identifier (<c>&lt;id&gt;.X</c> / <c>&lt;id&gt;</c>
        /// alone / as an argument), but NOT as the member NAME of an unrelated access (the <c>id</c> in
        /// <c>foo.id</c>). Covers both the VS <c>this.</c>-qualified idiom and hand/tool-written bare-id source, so the
        /// classifier and the safety gate see the SAME references the discovery side (Flatten) follows — without this,
        /// a bare <c>&lt;id&gt;.X = …</c> statement survives while its field is deleted (a dangling CS0103).</summary>
        private static HashSet<string> ReferencedFieldIds(SyntaxNode node, ISet<string> universe)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var n in node.DescendantNodesAndSelf())
            {
                if (n is MemberAccessExpressionSyntax ma && ma.Expression is ThisExpressionSyntax && universe.Contains(ma.Name.Identifier.Text))
                    set.Add(ma.Name.Identifier.Text);
                else if (n is IdentifierNameSyntax idn && universe.Contains(idn.Identifier.Text))
                {
                    // skip when it's the member NAME of an access (`foo.<id>` / the `<id>` inside `this.<id>` — the
                    // this-qualified case is already caught by the MemberAccess branch above)
                    if (idn.Parent is MemberAccessExpressionSyntax p && p.Name == idn) continue;
                    set.Add(idn.Identifier.Text);
                }
            }
            return set;
        }

        /// <summary>The root control id a statement OPERATES ON — the first identifier of an assignment's LHS
        /// (<c>this.&lt;id&gt;… = …</c>) or an invocation's receiver (<c>this.&lt;id&gt;….M(…)</c>), or null.</summary>
        private static string? ReceiverRoot(StatementSyntax st)
        {
            if (st is not ExpressionStatementSyntax es) return null;
            ExpressionSyntax? target = es.Expression switch
            {
                AssignmentExpressionSyntax asg => asg.Left,
                InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } => ma.Expression,
                _ => null,
            };
            if (target == null) return null;
            var chain = Flatten(target);
            return chain.Count >= 1 ? chain[0] : null;
        }

        /// <summary>Plan the surgery on the page's parenting <c>AddRange(new[]{…})</c>: every element must be a simple
        /// <c>this.&lt;id&gt;</c>; the subtree elements are trimmed. <paramref name="removeWhole"/> is true when EVERY
        /// element is in the subtree (the whole AddRange goes). Returns false (with a reason) for a non-trivial element.</summary>
        private static bool TryPlanAddRangeSurgery(StatementSyntax st, HashSet<string> closure,
            out List<ExpressionSyntax> trim, out bool removeWhole, out string? why)
        {
            trim = new List<ExpressionSyntax>(); removeWhole = false; why = null;
            var initializer = FindArrayInitializer(st);
            if (initializer == null) { why = "tab AddRange has no array initializer — cannot trim"; return false; }
            int nonSubtree = 0;
            foreach (var e in initializer.Expressions)
            {
                var f = Flatten(e);
                if (f.Count != 1) { why = "tab AddRange has a non-trivial element — cannot trim safely"; return false; }
                if (closure.Contains(f[0])) trim.Add(e); else nonSubtree++;
            }
            if (trim.Count == 0) { why = "tab AddRange does not contain the page"; return false; }
            removeWhole = nonSubtree == 0;
            return true;
        }

        /// <summary>safe-save gate for a tab-subtree removal: (1) NO surviving reference to a subtree control ANYWHERE in the
        /// InitializeComponent-bearing class — bare OR this-qualified, and across EVERY method (Dispose / helpers), not
        /// just InitializeComponent — so no dangling CS0103 slips through the parse-only check; (2) every REMOVED
        /// InitializeComponent statement referenced a subtree control (so no bystander was over-deleted); (3) at most
        /// ONE statement changed (the trimmed AddRange — must still say "AddRange"); (4) exactly the subtree's field
        /// declarations were removed (none added, all survivors were originals).</summary>
        public static bool OnlyTabSubtreeRemoved(string original, string edited, HashSet<string> closure)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();

            // (1) no surviving reference to a removed control, whole-class + bare-aware (defeats bare-id dangling AND
            // a reference in Dispose()/a hand-written helper that a parse-only check can't see).
            var eCls = FindClassWithIC(eRoot);
            if (eCls == null) return false;
            if (ReferencedFieldIds(eCls, closure).Count > 0) return false;

            // (2) every removed InitializeComponent statement referenced the subtree (AST + bare-aware, so we don't
            // demand `this.` and don't miss an over-deleted bystander on a shared line).
            var oNodes = InitStatementNodes(oRoot);
            var oNorm = oNodes.Select(n => NormalizeStmt(n.ToString())).ToList();
            var eNorm = InitStatements(eRoot);
            var oCount = Counter(oNorm);
            var eCount = Counter(eNorm);
            foreach (var kv in oCount)
            {
                int e = eCount.TryGetValue(kv.Key, out var c) ? c : 0;
                if (e < kv.Value)                                    // some instances of this statement were removed
                {
                    var node = oNodes[oNorm.IndexOf(kv.Key)];
                    if (ReferencedFieldIds(node, closure).Count == 0) return false; // removed something unrelated to the subtree
                }
            }

            // (3) at most one CHANGED statement, and it is the trimmed AddRange
            var added = MultisetSubtract(eNorm, oNorm).ToList();
            if (added.Count > 1) return false;
            if (added.Count == 1 && added[0].IndexOf("AddRange", StringComparison.Ordinal) < 0) return false;

            // (4) fields: exactly the subtree removed, nothing added
            var oF = FieldDeclNames(oRoot);
            var eF = FieldDeclNames(eRoot);
            foreach (var id in closure) { if (!oF.Contains(id)) return false; if (eF.Contains(id)) return false; }
            if (eF.Count != oF.Count - closure.Count) return false;
            foreach (var f in eF) if (!oF.Contains(f)) return false;
            return true;
        }

        /// <summary>The InitializeComponent statements of the IC-bearing class as AST nodes (the node counterpart of
        /// <see cref="InitStatements"/>, which returns their normalized text).</summary>
        private static List<StatementSyntax> InitStatementNodes(SyntaxNode root)
        {
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            return init?.Body != null ? init.Body.Statements.ToList() : new List<StatementSyntax>();
        }

        // ---- copy / paste (clipboard) ----

        /// <summary>The opaque clipboard payload (the engine's own JSON): the copied control's field type, its
        /// original field name, and the InitializeComponent statements that build it (construction + property
        /// assignments — event wirings and the parenting Controls.Add are dropped; Paste regenerates the latter
        /// for the chosen target).</summary>
        private sealed class ClipData
        {
            public int Version { get; set; } = 2;
            public string Fqn { get; set; } = "";
            public string Name { get; set; } = "";
            public List<string> Statements { get; set; } = new();
            public List<ClipDependency> Dependencies { get; set; } = new();
        }

        private sealed class ClipDependency
        {
            public string Name { get; set; } = "";
            public string Fqn { get; set; } = "";
        }

        /// <summary>
        /// Copy a LEAF control to an opaque clipboard blob: its field type + the InitializeComponent statements
        /// that build it (the <c>this.&lt;id&gt; = new…</c> ctor and every <c>this.&lt;id&gt;.X = …</c> / method call on it),
        /// EXCLUDING event wirings (<c>+=</c>) and the parenting <c>Controls.Add(this.&lt;id&gt;)</c> (Paste regenerates
        /// the Add for the chosen container). Refuses the root, a container WITH children, a shared field
        /// declaration, or a control referenced as an ARGUMENT elsewhere. Canonical common extender calls are the
        /// exception: their provider is captured as an exact typed dependency and validated again on paste.
        /// </summary>
        public static ControlCopyResult CopyControl(string src, string controlId)
        {
            if (controlId is "this" or "") return new ControlCopyResult { Safe = false, Reason = "cannot copy the root form" };
            if (!IsValidIdentifier(controlId)) return new ControlCopyResult { Safe = false, Reason = "invalid control id: " + controlId };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return new ControlCopyResult { Safe = false, Reason = "InitializeComponent not found" };
            if (!GatherFieldNames(cls).Contains(controlId)) return new ControlCopyResult { Safe = false, Reason = "unknown control: " + controlId };

            var fieldDecl = cls.Members.OfType<FieldDeclarationSyntax>()
                .FirstOrDefault(f => f.Declaration.Variables.Any(v => v.Identifier.Text == controlId));
            if (fieldDecl == null) return new ControlCopyResult { Safe = false, Reason = "field declaration not found" };
            if (fieldDecl.Declaration.Variables.Count != 1)
                return new ControlCopyResult { Safe = false, Reason = "control shares a field declaration with other fields" };
            string fqn = fieldDecl.Declaration.Type.ToString();
            if (!IsValidTypeName(fqn)) return new ControlCopyResult { Safe = false, Reason = "control has an unrecognized field type" };

            var fieldTypes = GatherFieldTypes(cls);
            var statements = new List<string>();
            var dependencies = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var st in init.Body.Statements)
            {
                bool include = ClassifyForCopy(st, controlId, out bool refuse, out string? why);
                if (refuse) return new ControlCopyResult { Safe = false, Reason = why ?? "control is referenced elsewhere" };
                if (!include) continue;
                // Only clone statements we can FAITHFULLY reproduce: an assignment/layout-call on the control whose
                // values are designer-representable (literals, enums, Point/Size/Color/Font/… ) — never one that
                // references a sibling or calls into a non-designer type. This keeps the clip clean so PasteControl
                // (which re-validates identically) accepts a real copy while rejecting a crafted blob.
                if (st is not ExpressionStatementSyntax es)
                    return new ControlCopyResult { Safe = false, Reason = "control has a statement that cannot be safely copied" };
                foreach (string dep in DependencyIds(st, controlId))
                {
                    if (!fieldTypes.TryGetValue(dep, out var depType) || !IsValidTypeName(depType))
                        return new ControlCopyResult { Safe = false, Reason = "control depends on an unsupported field: " + dep };
                    dependencies[dep] = depType;
                }
                if (!IsAllowedControlStatement(es.Expression, controlId, fqn, dependencies))
                    return new ControlCopyResult { Safe = false, Reason = "control has a statement that cannot be safely copied" };
                statements.Add(st.ToString());
            }
            if (statements.Count == 0) return new ControlCopyResult { Safe = false, Reason = "nothing to copy" };

            var clip = new ClipData
            {
                Fqn = fqn,
                Name = controlId,
                Statements = statements,
                Dependencies = dependencies.Select(kv => new ClipDependency { Name = kv.Key, Fqn = kv.Value })
                    .OrderBy(x => x.Name, StringComparer.Ordinal).ToList(),
            };
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
                        bool isCommonExtender = receiver.Count == 1
                            && CopyableExtenderMethods.Contains(method)
                            && inv.ArgumentList.Arguments.Count == 2
                            && Flatten(inv.ArgumentList.Arguments[0].Expression) is { Count: 1 } target
                            && target[0] == id;
                        if (isCommonExtender) return true; // exact provider type/method validation happens below
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
        /// the target. Same safe-save <see cref="OnlyControlAdded"/> gate as AddControl (only the new control was added).
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
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return new ControlPasteResult { Safe = false, Reason = "InitializeComponent not found" };

            var names = GatherFieldNames(cls);
            if (!parentRoot && !names.Contains(parentId)) return new ControlPasteResult { Safe = false, Reason = "unknown parent: " + parentId };

            var targetFieldTypes = GatherFieldTypes(cls);
            var dependencyIds = new HashSet<string>(StringComparer.Ordinal);
            var dependencyTypes = new Dictionary<string, string>(StringComparer.Ordinal);
            var missingDependencies = new List<string>();
            foreach (var dependency in clip.Dependencies ?? new List<ClipDependency>())
            {
                if (!IsValidIdentifier(dependency.Name) || !IsValidTypeName(dependency.Fqn)
                    || dependency.Name == clip.Name || !dependencyIds.Add(dependency.Name))
                    return new ControlPasteResult { Safe = false, Reason = "clipboard dependency metadata is invalid" };
                dependencyTypes[dependency.Name] = dependency.Fqn;
                if (!targetFieldTypes.TryGetValue(dependency.Name, out var targetType)
                    || !string.Equals(targetType, dependency.Fqn, StringComparison.Ordinal))
                    missingDependencies.Add(dependency.Name + " (" + dependency.Fqn + ")");
            }
            if (missingDependencies.Count > 0)
                return new ControlPasteResult
                {
                    Safe = false,
                    Reason = "unavailable dependencies: " + string.Join(", ", missingDependencies),
                    MissingDependencies = missingDependencies,
                };

            string baseName = VsBaseName(clip.Fqn);
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
                string? processed = ProcessPastedStatement(raw, clip.Name, newName, clip.Fqn, dependencyTypes);
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
            // Surface the clone's type + nudged Location so the net48 compiled-preview host can live-instantiate it
            // (the text splice above is enough for the net9 renderer, but the compiled instance is mutated directly).
            (int px, int py) = PastedLocation(clip.Statements);
            return new ControlPasteResult { Safe = true, Name = newName, NewText = finalText, TypeName = clip.Fqn, X = px, Y = py };
        }

        /// <summary>Read the copied control's integer Location from the clip statements and apply the same
        /// <see cref="PasteOffset"/> nudge <see cref="ProcessPastedStatement"/> emits, so the net48 host places the
        /// live clone where the pasted text puts it. Returns (-1,-1) when there is no representable Location
        /// (the net48 AddControl then leaves the control at its default position).</summary>
        private static (int, int) PastedLocation(List<string> statements)
        {
            foreach (var raw in statements)
            {
                if (SyntaxFactory.ParseStatement(raw) is ExpressionStatementSyntax es
                    && es.Expression is AssignmentExpressionSyntax asg
                    && asg.Left is MemberAccessExpressionSyntax ma && ma.Name.Identifier.Text == "Location"
                    && asg.Right is ObjectCreationExpressionSyntax oce && oce.ArgumentList?.Arguments.Count == 2
                    && TryConstInt(oce.ArgumentList.Arguments[0].Expression, out int x)
                    && TryConstInt(oce.ArgumentList.Arguments[1].Expression, out int y))
                    return (Math.Max(0, x + PasteOffset), Math.Max(0, y + PasteOffset));
            }
            return (-1, -1);
        }

        /// <summary>Validate + rename + retouch ONE cloned statement on the AST, returning the emit text or null to
        /// REJECT. Validation (<see cref="IsAllowedControlStatement"/>) requires an assignment/layout-call on
        /// <paramref name="oldId"/> with designer-representable values — so a crafted clip can't smuggle a
        /// side-effecting RHS or an undeclared sibling reference. The receiver rename is done on the syntax tree
        /// (string literals and comments are never touched), the <c>Name</c> property is kept equal to the new field
        /// name, and an
        /// integer <c>Location</c> is nudged by <see cref="PasteOffset"/>.</summary>
        private static string? ProcessPastedStatement(string rawStmt, string oldId, string newName, string fqn,
            IReadOnlyDictionary<string, string> dependencyTypes)
        {
            var parsed = SyntaxFactory.ParseStatement(rawStmt);
            if (parsed.ContainsDiagnostics || parsed is not ExpressionStatementSyntax es) return null;
            if (!IsAllowedControlStatement(es.Expression, oldId, fqn, dependencyTypes)) return null;

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
        private static readonly HashSet<string> CopyableExtenderMethods = new(StringComparer.Ordinal)
        {
            "SetToolTip",
            "SetError", "SetIconAlignment", "SetIconPadding",
            "SetHelpString", "SetHelpKeyword", "SetHelpNavigator", "SetShowHelp",
        };

        /// <summary>True when <paramref name="expr"/> is a statement a control can OWN and a copy can faithfully
        /// reproduce: <c>this.&lt;id&gt; = new &lt;fqn&gt;(safeArgs)</c> (the ctor), <c>this.&lt;id&gt;.&lt;member…&gt; = &lt;safe value&gt;</c>
        /// (a property), or <c>this.&lt;id&gt;.&lt;layoutMethod&gt;(safeArgs)</c>. Anything else (a Controls.Add, a sibling
        /// reference, a non-designer call) is rejected.</summary>
        private static bool IsAllowedControlStatement(ExpressionSyntax expr, string ownerId, string fqn,
            IReadOnlyDictionary<string, string>? allowedDependencies = null)
        {
            HashSet<string>? dependencyNames = allowedDependencies == null
                ? null
                : new HashSet<string>(allowedDependencies.Keys, StringComparer.Ordinal);
            if (expr is AssignmentExpressionSyntax asg)
            {
                if (!asg.IsKind(SyntaxKind.SimpleAssignmentExpression)) return false;
                var lhs = Flatten(asg.Left);
                if (lhs.Count < 1 || lhs[0] != ownerId) return false;
                if (lhs.Count == 1)
                    return asg.Right is ObjectCreationExpressionSyntax oc && oc.Type.ToString() == fqn
                        && (oc.ArgumentList == null || oc.ArgumentList.Arguments.All(a => IsSafeValueExpr(a.Expression, dependencyNames)));
                return IsSafeValueExpr(asg.Right, dependencyNames);
            }
            if (expr is InvocationExpressionSyntax inv && inv.Expression is MemberAccessExpressionSyntax ma)
            {
                var recv = Flatten(ma.Expression);
                if (recv.Count == 1 && recv[0] == ownerId && CopyableMethods.Contains(ma.Name.Identifier.Text))
                    return inv.ArgumentList.Arguments.All(a => IsSafeValueExpr(a.Expression, dependencyNames));
                if (recv.Count == 2 && recv[0] == ownerId && recv[1] == "DataBindings"
                    && ma.Name.Identifier.ValueText == "Add" && inv.ArgumentList.Arguments.Count == 1)
                    return IsSafeValueExpr(inv.ArgumentList.Arguments[0].Expression, dependencyNames);
                if (IsCopyableExtenderInvocation(inv, ma, ownerId, allowedDependencies))
                    return true;
            }
            return false;
        }

        /// <summary>Closed validation for an extender call copied with a control. The provider itself is a typed
        /// clipboard dependency, the first argument must be the copied control, and only the common framework
        /// provider/method pairs supported by the 1.2 property-grid editor are allowed.</summary>
        private static bool IsCopyableExtenderInvocation(InvocationExpressionSyntax invocation,
            MemberAccessExpressionSyntax method, string ownerId,
            IReadOnlyDictionary<string, string>? allowedDependencies)
        {
            if (allowedDependencies == null || invocation.ArgumentList.Arguments.Count != 2)
                return false;
            var receiver = Flatten(method.Expression);
            if (receiver.Count != 1 || !allowedDependencies.TryGetValue(receiver[0], out var providerType))
                return false;
            var target = Flatten(invocation.ArgumentList.Arguments[0].Expression);
            if (target.Count != 1 || target[0] != ownerId)
                return false;

            string normalizedType = providerType.Replace("global::", "", StringComparison.Ordinal);
            string methodName = method.Name.Identifier.ValueText;
            bool supported = normalizedType switch
            {
                "System.Windows.Forms.ToolTip" => methodName == "SetToolTip",
                "System.Windows.Forms.ErrorProvider" => methodName is "SetError" or "SetIconAlignment" or "SetIconPadding",
                "System.Windows.Forms.HelpProvider" => methodName is "SetHelpString" or "SetHelpKeyword" or "SetHelpNavigator" or "SetShowHelp",
                _ => false,
            };
            return supported && IsSafeValueExpr(invocation.ArgumentList.Arguments[1].Expression);
        }

        /// <summary>True when an expression is a designer-representable VALUE: literals, enum/static member reads, and
        /// constructions/calls of designer value types (Point/Size/Color/Font/…). Direct <c>this.&lt;x&gt;</c>
        /// references are accepted only when <c>x</c> is declared in the clipboard dependency set; nested references,
        /// lambdas, await, and constructions/invocations of non-designer types remain rejected.</summary>
        private static bool IsSafeValueExpr(ExpressionSyntax expr, HashSet<string>? allowedDependencies = null)
        {
            foreach (var node in expr.DescendantNodesAndSelf())
            {
                switch (node)
                {
                    case AnonymousFunctionExpressionSyntax: return false;
                    case AwaitExpressionSyntax: return false;
                    case MemberAccessExpressionSyntax m when IsRootedAtThis(m):
                        var chain = Flatten(m);
                        if (chain.Count != 1 || allowedDependencies == null || !allowedDependencies.Contains(chain[0]))
                            return false;
                        break;
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
        private static bool IsRootedAtThis(ExpressionSyntax expression) => expression switch
        {
            MemberAccessExpressionSyntax member => IsRootedAtThis(member.Expression),
            ParenthesizedExpressionSyntax parenthesized => IsRootedAtThis(parenthesized.Expression),
            ThisExpressionSyntax => true,
            _ => false,
        };

        private static HashSet<string> DependencyIds(SyntaxNode statement, string ownerId)
        {
            var result = new HashSet<string>(StringComparer.Ordinal);
            foreach (var member in statement.DescendantNodesAndSelf().OfType<MemberAccessExpressionSyntax>())
                if (member.Expression is ThisExpressionSyntax
                    && member.Name.Identifier.ValueText != ownerId)
                    result.Add(member.Name.Identifier.ValueText);
            return result;
        }

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
            var init = FormClassResolver.InitMethodOf(cls);
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

        /// <summary>safe-save gate for a z-order move: the InitializeComponent statement multiset and the field
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

        // ---- reparent (move a control into a different container / the root) ----

        /// <summary>
        /// Reparent a LEAF control into a different container (or the root form). Rewrites ONLY the receiver of the
        /// child's single 1-arg <c>&lt;oldParent&gt;.Controls.Add(this.&lt;child&gt;)</c> to
        /// <c>&lt;newParent&gt;.Controls.Add(...)</c> (newParent "this"/"" = root). A minimal, byte-local text edit — the
        /// child keeps its Location value (now interpreted relative to the new parent). Refuses the root, a child sitting
        /// in a TableLayoutPanel cell (3-arg Add — reparent via the grid), a container WITH children (leaf-only v1, so
        /// no parent cycle is possible), a missing/self new parent, or a no-op (already there). The edit is verified by
        /// <see cref="OnlyReparented"/> (only that one Add's parent changed).
        /// </summary>
        public static ControlReorderResult Reparent(string src, string childId, string newParentId)
        {
            if (childId is "this" or "") return new ControlReorderResult { Safe = false, Reason = "cannot reparent the root form" };
            if (!IsValidIdentifier(childId)) return new ControlReorderResult { Safe = false, Reason = "invalid control id: " + childId };
            bool toRoot = newParentId is "this" or "";
            if (!toRoot && !IsValidIdentifier(newParentId)) return new ControlReorderResult { Safe = false, Reason = "invalid parent id: " + newParentId };
            if (!toRoot && newParentId == childId) return new ControlReorderResult { Safe = false, Reason = "cannot reparent a control into itself" };

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return new ControlReorderResult { Safe = false, Reason = "InitializeComponent not found" };
            var names = GatherFieldNames(cls);
            if (!names.Contains(childId)) return new ControlReorderResult { Safe = false, Reason = "unknown control: " + childId };
            if (!toRoot && !names.Contains(newParentId)) return new ControlReorderResult { Safe = false, Reason = "unknown parent: " + newParentId };

            // The new parent must be a WinForms container that accepts a DIRECT Controls.Add(child), validated by its
            // DECLARED TYPE (this editor is pure-text — no type resolution). Rejects a non-Control field (ToolTip/Timer/
            // ImageList → would emit non-compiling `<field>.Controls.Add(...)`) and a special-add container
            // (SplitContainer→Panel1/2, TableLayoutPanel→3-arg cell, TabControl→TabPages, ToolStrip→Items → whose
            // Controls throws at load and silently detaches the child). A CUSTOM container subclass is not recognized
            // here (declined, never corrupted) — the host, which knows resolved types, can offer richer drop targets.
            if (!toRoot)
            {
                string? ptype = FieldTypeShortName(cls, newParentId);
                if (ptype == null || !DirectAddContainers.Contains(ptype))
                    return new ControlReorderResult { Safe = false, Reason = "target is not a container that accepts a direct child (use Panel/GroupBox/FlowLayoutPanel/…) — cannot reparent here" };
            }

            // the child's single parenting Add (1-arg) — a 3-arg TableLayoutPanel cell child does not match → declined
            StatementSyntax? add = null; List<string>? curParent = null;
            foreach (var st in init.Body.Statements)
                if (IsControlsAddOf(st, out var pchain, out var child) && child == childId) { add = st; curParent = pchain; break; }
            if (add == null || curParent == null)
                return new ControlReorderResult { Safe = false, Reason = "control is not parented by a 1-arg Controls.Add (a TableLayoutPanel cell?) — cannot reparent" };

            // leaf-only (cycle-safe): refuse a child that itself parents ANY children — via any Controls.Add /
            // Controls.AddRange rooted at the child, in ANY form: 1-arg, a TableLayoutPanel 3-arg cell Add, or a
            // nested SplitContainer Panel1/Panel2 add. Catching every form keeps reparent cycle-free (a true leaf
            // has no descendants, so the new parent can never lie inside it).
            foreach (var st in init.Body.Statements)
                if (ParentsAChild(st, childId))
                    return new ControlReorderResult { Safe = false, Reason = "control is a container with children — reparent them first (leaf-only)" };

            bool sameParent = toRoot ? curParent.Count == 0 : (curParent.Count == 1 && curParent[0] == newParentId);
            if (sameParent) return new ControlReorderResult { Safe = true, NewText = src }; // already there → no-op

            var inv = (InvocationExpressionSyntax)((ExpressionStatementSyntax)add).Expression;
            var recv = ((MemberAccessExpressionSyntax)inv.Expression).Expression; // the "<X>.Controls" before ".Add"
            string newRecv = toRoot ? "this.Controls" : "this." + newParentId + ".Controls";
            string text = src.Substring(0, recv.SpanStart) + newRecv + src.Substring(recv.Span.End);

            bool parseOk = !CSharpSyntaxTree.ParseText(text).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);
            if (!parseOk || !OnlyReparented(src, text, childId, newParentId))
                return new ControlReorderResult { Safe = false, Reason = !parseOk ? "reparented text has syntax errors" : "edit changed more than the control's parent" };
            return new ControlReorderResult { Safe = true, NewText = text };
        }

        /// <summary>safe-save gate for a reparent: every statement EXCEPT the child's single Controls.Add is byte-identical
        /// (multiset), the child is parented by exactly one 1-arg Controls.Add before and after, that Add now targets
        /// <paramref name="newParentId"/> ("this"/"" = root), and the field declarations are unchanged.</summary>
        public static bool OnlyReparented(string original, string edited, string childId, string newParentId)
        {
            bool toRoot = newParentId is "this" or "";
            var (oNon, oTgts) = ClassifyReparent(original, childId);
            var (eNon, eTgts) = ClassifyReparent(edited, childId);
            if (oTgts.Count != 1 || eTgts.Count != 1) return false;
            if (!MultisetEqual(oNon, eNon)) return false;
            if (!IsControlsAddOf(eTgts[0], out var chain, out var child) || child != childId) return false;
            bool chainOk = toRoot ? chain.Count == 0 : (chain.Count == 1 && chain[0] == newParentId);
            if (!chainOk) return false;
            return MultisetEqual(FieldDeclNames(CSharpSyntaxTree.ParseText(original).GetRoot()),
                                 FieldDeclNames(CSharpSyntaxTree.ParseText(edited).GetRoot()));
        }

        /// <summary>WinForms container types whose <c>Controls.Add(child)</c> accepts a plain Control DIRECTLY (the
        /// only valid reparent targets besides the root). Excludes SplitContainer/TableLayoutPanel/TabControl/ToolStrip
        /// (special add paths) and every non-Control component. Matched by the field's declared type SHORT name — a
        /// custom subclass is not recognized (reparent declines rather than emit source that breaks compile/load).</summary>
        private static readonly HashSet<string> DirectAddContainers = new(StringComparer.Ordinal)
        {
            "Panel", "GroupBox", "FlowLayoutPanel", "TabPage", "UserControl",
            "ContainerControl", "ScrollableControl", "SplitterPanel", "ToolStripContentPanel", "ToolStripPanel",
        };

        /// <summary>The declared type's SHORT name (last dotted segment) of the field named <paramref name="fieldName"/>
        /// in <paramref name="cls"/>, or null when absent — e.g. "System.Windows.Forms.Panel" → "Panel".</summary>
        private static string? FieldTypeShortName(ClassDeclarationSyntax cls, string fieldName)
        {
            foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
                foreach (var v in f.Declaration.Variables)
                    if (v.Identifier.Text == fieldName)
                    {
                        string t = f.Declaration.Type.ToString();
                        int i = t.LastIndexOf('.');
                        return (i < 0 ? t : t.Substring(i + 1)).Trim();
                    }
            return null;
        }

        /// <summary>True when <paramref name="st"/> is a <c>Controls.Add</c>/<c>Controls.AddRange</c> whose receiver is
        /// rooted at <paramref name="id"/> (any form: <c>id.Controls.Add(x)</c>, a 3-arg cell add, or a nested
        /// <c>id.Panel1.Controls.Add(x)</c>) — i.e. <paramref name="id"/> parents at least one child.</summary>
        private static bool ParentsAChild(StatementSyntax st, string id)
        {
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv }) return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma) return false;
            string method = ma.Name.Identifier.Text;
            if (method != "Add" && method != "AddRange") return false;
            var chain = Flatten(ma.Expression);
            return chain.Count >= 1 && chain[0] == id && chain.Contains("Controls");
        }

        /// <summary>Split InitializeComponent into (non-target statements, the child's 1-arg Controls.Add calls).</summary>
        private static (List<string> non, List<StatementSyntax> tgts) ClassifyReparent(string code, string childId)
        {
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            var cls = FindClassWithIC(root);
            var init = FormClassResolver.InitMethodOf(cls);
            var non = new List<string>(); var tgts = new List<StatementSyntax>();
            if (init?.Body != null)
                foreach (var st in init.Body.Statements)
                {
                    if (IsControlsAddOf(st, out _, out var c) && c == childId) tgts.Add(st);
                    else non.Add(NormalizeStmt(st.ToString()));
                }
            return (non, tgts);
        }

        private static bool MultisetEqual(List<string> a, List<string> b)
        {
            if (a.Count != b.Count) return false;
            var ca = Counter(a); var cb = Counter(b);
            if (ca.Count != cb.Count) return false;
            foreach (var kv in ca) if (!cb.TryGetValue(kv.Key, out var n) || n != kv.Value) return false;
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

        // ---- helpers ----

        // THE form class, via the one shared rule (see FormClassResolver). This used to be a private copy taking the
        // first class in the file declaring InitializeComponent BY NAME; every editor had its own. They agreed only by
        // luck, and a disagreement splices one class's body into another's. Null (no single designer class) is what
        // every caller already turns into a refusal.
        // ---- shared with DesignerLocalizeForm: the same parsing/splicing primitives every source rewrite uses,
        // so the localizable conversion cannot drift from what add/remove/rename already agree on. ----

        internal static ClassDeclarationSyntax? FindClassWithICShared(SyntaxNode root) => FindClassWithIC(root);

        internal static List<string> FlattenChain(ExpressionSyntax expr) => Flatten(expr);

        internal static string Normalize(string statementText) => NormalizeStmt(statementText);

        internal static List<string> InitStatementTexts(string src) =>
            InitStatements(CSharpSyntaxTree.ParseText(src).GetRoot());

        internal static (int Start, int End) StatementLineRange(string src, SyntaxNode statement) =>
            LineRange(src, statement.SpanStart, statement.Span.End);

        /// <summary>Indentation of InitializeComponent's own statements.</summary>
        internal static string StatementIndent(string src, MethodDeclarationSyntax init) => BodyIndent(src, init);

        /// <summary>Start of the line holding InitializeComponent's first statement — where a declaration the whole
        /// method depends on (the ComponentResourceManager) goes. -1 when the method has no body.</summary>
        internal static int FirstStatementLinePos(string src, string className)
        {
            var cls = FindClassWithIC(CSharpSyntaxTree.ParseText(src).GetRoot());
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return -1;
            if (!string.Equals(cls.Identifier.Text, className, StringComparison.Ordinal)) return -1;
            var first = init.Body.Statements.FirstOrDefault();
            return first == null ? FirstBodyLinePos(src, init) : LineStartOfStatement(src, first);
        }

        private static ClassDeclarationSyntax? FindClassWithIC(SyntaxNode root) =>
            FormClassResolver.FormClass(root);

        // The form's component fields across ALL its partials (shared rule) — not just the InitializeComponent-bearing
        // one. These names both generate fresh ids and answer "is this control mine": a partial-blind scan could mint a
        // name that collides with a field in the form's OTHER partial (CS0102), or refuse a control that plainly exists.
        private static HashSet<string> GatherFieldNames(ClassDeclarationSyntax cls) => FormClassResolver.FieldNamesOf(cls);

        private static Dictionary<string, string> GatherFieldTypes(ClassDeclarationSyntax cls)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var part in FormClassResolver.PartialsOf(cls))
                foreach (var field in part.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var variable in field.Declaration.Variables)
                        result[variable.Identifier.ValueText] = field.Declaration.Type.ToString();
            return result;
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
            var init = FormClassResolver.InitMethodOf(cls);
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

        /// <summary>
        /// The base field name Visual Studio's designer generates for a type: the short type name with only its
        /// FIRST letter lowered (CheckBox → checkBox, DataGridView → dataGridView). Lowercasing the whole name
        /// produced `checkbox1` where every VS-generated form has `checkBox1`.
        /// </summary>
        private static string VsBaseName(string fqn)
        {
            string s = ShortName(fqn);
            return s.Length == 0 ? s : char.ToLowerInvariant(s[0]) + s.Substring(1);
        }

        private static string UniqueName(string baseName, HashSet<string> names)
        {
            // C# identifiers are case-sensitive, but the WinForms component container is not: adding `tabpage1`
            // beside an existing `tabPage1` throws while the generated designer is interpreted. Generate against a
            // case-insensitive view so every source writer produces names that both C# and DesignSurface can accept.
            var occupied = new HashSet<string>(names, StringComparer.OrdinalIgnoreCase);
            for (int i = 1; i < 100000; i++)
            {
                string cand = baseName + i;
                if (!occupied.Contains(cand)) return cand;
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

        /// <summary>The `this.&lt;field&gt; = new T(…);` statements Visual Studio keeps as one run at the very top of
        /// InitializeComponent. A leading assignment counts only while its target is a FIELD of the class — that is
        /// what separates `this.button1 = new Button()` from `this.ClientSize = new Size(800, 450)`.</summary>
        private static List<StatementSyntax> LeadingCtorRun(MethodDeclarationSyntax init, HashSet<string> fieldNames)
        {
            var run = new List<StatementSyntax>();
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assign }) break;
                if (assign.Right is not ObjectCreationExpressionSyntax) break;
                var chain = Flatten(assign.Left);
                if (chain.Count != 1 || !fieldNames.Contains(chain[0])) break;
                run.Add(st);
            }
            return run;
        }

        /// <summary>The `this.&lt;owner&gt;.…` / `&lt;owner&gt;.Controls.Add(…)` statements that make up one component's
        /// property block. For the root these are the bare `this.&lt;Prop&gt; = …` and `this.Controls.Add(…)` statements
        /// of the form's own block — constructors excluded, since those live in the leading run.</summary>
        private static List<StatementSyntax> BlockOf(MethodDeclarationSyntax init, string owner, bool ownerRoot,
            HashSet<string> fieldNames)
        {
            var ctors = new HashSet<StatementSyntax>(LeadingCtorRun(init, fieldNames));
            var block = new List<StatementSyntax>();
            foreach (var st in init.Body!.Statements)
            {
                if (ctors.Contains(st) || IsLayoutCall(st)) continue;
                List<string> chain = st switch
                {
                    ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a } => Flatten(a.Left),
                    ExpressionStatementSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } }
                        => Flatten(ma.Expression),
                    _ => new List<string>(),
                };
                if (chain.Count == 0) continue;
                bool mine = ownerRoot
                    // `this.Text = …` / `this.Controls.Add(…)`: a root member, and never a field (that is a ctor).
                    ? !fieldNames.Contains(chain[0])
                    : chain[0] == owner;
                if (mine) block.Add(st);
            }
            return block;
        }

        /// <summary>Where each part of a new control's generated code belongs in an existing InitializeComponent.</summary>
        private sealed class InitLayoutPlan
        {
            public int CtorPos;            // end of the leading `this.X = new T();` run
            public int PropertiesPos;      // before the parent's own block (children serialize before their parent)
            public int AddPos;             // before the parent's first existing Controls.Add, else in block order
            public int ResumePos;          // end of the method body
            public int RootBlockPos = -1;  // start of the form's block, when it has no `// Form1` header yet
            public int BodyEnd;            // append position, for a form whose block is empty
            public bool HasSuspendLayout;
            public List<StatementSyntax> RootBlock = new();

            /// <summary>True when the form's own block already assigns this property.</summary>
            public bool RootAssigns(string member) =>
                RootBlock.Any(st => string.Equals(AssignedMemberName(st, true), member, StringComparison.Ordinal));
        }

        private static bool IsSuspendCall(StatementSyntax st) =>
            IsLayoutCall(st) && st.ToString().Contains("SuspendLayout");

        /// <summary>An AutoScaleDimensions pair as the designer serializes it — two float literals, nothing else.
        /// The value crosses an RPC boundary, so it is validated before it reaches generated source.</summary>
        private static bool IsAutoScalePair(string? value) =>
            value != null && System.Text.RegularExpressions.Regex.IsMatch(value, @"^\d{1,4}(\.\d{1,4})?F,\s\d{1,4}(\.\d{1,4})?F$");

        /// <summary>Locate every anchor a Visual-Studio-shaped insert needs. Anything missing degrades to appending
        /// at the end of the method — the pre-1.9 behavior — so a designer file with an unfamiliar shape is never
        /// rearranged, only added to.</summary>
        private static InitLayoutPlan InitLayout(string src, MethodDeclarationSyntax init, ClassDeclarationSyntax cls,
            HashSet<string> fieldNames, string parentId, bool parentRoot)
        {
            var plan = new InitLayoutPlan();
            var statements = init.Body!.Statements;
            var ctorRun = LeadingCtorRun(init, fieldNames);
            int bodyEnd = InitInsertPos(src, init);

            plan.HasSuspendLayout = statements.Any(IsSuspendCall);
            plan.CtorPos = ctorRun.Count > 0 ? LineEndOf(src, ctorRun[ctorRun.Count - 1]) : FirstBodyLinePos(src, init);
            plan.ResumePos = LineStartOfPos(src, init.Body.CloseBraceToken.SpanStart);

            var rootBlock = BlockOf(init, "", true, fieldNames);
            var parentBlock = parentRoot ? rootBlock : BlockOf(init, parentId, false, fieldNames);
            if (rootBlock.Count > 0 && !HasBlockHeader(src, rootBlock[0])) plan.RootBlockPos = LineStartOfBlock(src, rootBlock[0]);
            plan.RootBlock = rootBlock;
            plan.BodyEnd = bodyEnd;

            plan.PropertiesPos = parentBlock.Count > 0 ? LineStartOfBlock(src, parentBlock[0])
                : rootBlock.Count > 0 ? LineStartOfBlock(src, rootBlock[0])
                : bodyEnd;

            var existingAdds = parentBlock.Where(st => AssignedMemberName(st, parentRoot) == "Controls").ToList();
            plan.AddPos = existingAdds.Count > 0
                ? LineStartOfStatement(src, existingAdds[0]) // newest first == on top, like VS
                : BlockOrderPos(src, parentBlock, "Controls", plan.PropertiesPos);
            return plan;
        }

        /// <summary>Where a member belongs inside one already-serialized block: Visual Studio writes a block's
        /// members alphabetically, so the insert goes above the first member that sorts after it.</summary>
        private static int BlockOrderPos(string src, List<StatementSyntax> block, string member, int fallback)
        {
            var after = block.FirstOrDefault(st =>
                string.Compare(AssignedMemberName(st, true), member, StringComparison.OrdinalIgnoreCase) > 0);
            if (after != null) return LineStartOfStatement(src, after);
            return block.Count > 0 ? LineEndOf(src, block[block.Count - 1]) : fallback;
        }

        /// <summary>The line range of the `//`-`// name`-`//` header directly above a control's first statement,
        /// or null when the statements carry no such header. Only a header naming THIS control is matched, so a
        /// hand-written comment above the block is left untouched.</summary>
        private static (int s, int e)? BlockHeaderRange(string src, List<StatementSyntax> removed, string controlId)
        {
            // The header sits above the control's PROPERTY block, not above its constructor (which lives in the
            // leading run), so every removed statement is a candidate.
            foreach (var st in removed)
            {
                var range = HeaderAbove(src, st, controlId);
                if (range != null) return range;
            }
            return null;
        }

        private static (int s, int e)? HeaderAbove(string src, StatementSyntax statement, string controlId)
        {
            int firstLine = LineStartOfStatement(src, statement);
            int start = firstLine;
            var lines = new List<string>();
            while (start > 0)
            {
                int prev = src.LastIndexOf('\n', Math.Max(0, start - 2)) + 1;
                if (prev == start) break;
                string line = src.Substring(prev, start - prev).Trim();
                if (!line.StartsWith("//", StringComparison.Ordinal) || line.StartsWith("///", StringComparison.Ordinal)) break;
                lines.Insert(0, line);
                start = prev;
            }
            // Exactly Visual Studio's three-line header for this control, nothing more.
            if (lines.Count != 3 || lines[0] != "//" || lines[2] != "//") return null;
            return lines[1] == "// " + controlId ? (start, firstLine) : null;
        }

        /// <summary>True when a statement already carries Visual Studio's `//`-`// name`-`//` block header.</summary>
        private static bool HasBlockHeader(string src, StatementSyntax first)
        {
            int lineStart = LineStartOfStatement(src, first);
            int prevStart = src.LastIndexOf('\n', Math.Max(0, lineStart - 2)) + 1;
            return src.Substring(prevStart, Math.Max(0, lineStart - prevStart)).TrimStart().StartsWith("//", StringComparison.Ordinal);
        }

        private static int FirstBodyLinePos(string src, MethodDeclarationSyntax init)
        {
            int ob = init.Body!.OpenBraceToken.Span.End;
            int nl = src.IndexOf('\n', ob);
            return nl < 0 ? ob : nl + 1;
        }

        private static int LineStartOfPos(string src, int pos) => src.LastIndexOf('\n', Math.Max(0, pos - 1)) + 1;

        /// <summary>Apply (position, text) inserts to one source string. Groups sharing a position keep their Seq
        /// order; groups are applied back-to-front so earlier positions stay valid.</summary>
        private static string ApplyInserts(string src, List<(int Pos, int Seq, string Text)> inserts)
        {
            foreach (var group in inserts.GroupBy(i => i.Pos).OrderByDescending(g => g.Key))
            {
                string text = string.Concat(group.OrderBy(i => i.Seq).Select(i => i.Text));
                src = src.Substring(0, group.Key) + text + src.Substring(group.Key);
            }
            return src;
        }

        /// <summary>Controls whose Visual Studio designer turns AutoSize on when it creates them — the text-sized
        /// ones, which then fit themselves to their caption instead of keeping a designed Size.</summary>
        private static readonly HashSet<string> DesignerAutoSized = new(StringComparer.Ordinal)
        {
            "System.Windows.Forms.Label", "System.Windows.Forms.LinkLabel",
            "System.Windows.Forms.CheckBox", "System.Windows.Forms.RadioButton",
        };

        private static bool AutoSizedByDesigner(string fqn) => DesignerAutoSized.Contains(fqn);

        /// <summary>True for the ButtonBase family, whose designer writes `UseVisualStyleBackColor = true` on every
        /// control it creates. Framework types only — a project control is emitted exactly as before.</summary>
        private static bool HasVisualStyleBackColor(string fqn)
        {
            var t = typeof(System.Windows.Forms.Control).Assembly.GetType(fqn);
            var p = t?.GetProperty("UseVisualStyleBackColor",
                System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Instance);
            return p != null && p.PropertyType == typeof(bool) && p.CanWrite;
        }

        /// <summary>Start-of-line position for a statement — where an insert lands to sit directly above it.</summary>
        private static int LineStartOfStatement(string src, SyntaxNode node) =>
            src.LastIndexOf('\n', Math.Max(0, node.SpanStart - 1)) + 1;

        /// <summary>Start of a whole BLOCK: like <see cref="LineStartOfStatement"/>, but walking above any `//`
        /// header lines that belong to the statement — otherwise a new block would be inserted BETWEEN a header
        /// and the block it names.</summary>
        private static int LineStartOfBlock(string src, SyntaxNode node)
        {
            int pos = LineStartOfStatement(src, node);
            while (pos > 0)
            {
                int prev = src.LastIndexOf('\n', Math.Max(0, pos - 2)) + 1;
                if (prev == pos) break;
                string line = src.Substring(prev, pos - prev).Trim();
                if (!line.StartsWith("//", StringComparison.Ordinal) || line.StartsWith("///", StringComparison.Ordinal)) break;
                pos = prev;
            }
            return pos;
        }

        /// <summary>Position just after a statement's line (where the next statement would begin).</summary>
        private static int LineEndOf(string src, SyntaxNode node)
        {
            int nl = src.IndexOf('\n', node.Span.End);
            return nl < 0 ? src.Length : nl + 1;
        }

        /// <summary>The property name a `this.X.Prop = …` / `this.Prop = …` statement assigns, for the alphabetical
        /// order Visual Studio's serializer emits within one block ("Controls" sorts between ClientSize and Name).</summary>
        private static string AssignedMemberName(StatementSyntax st, bool ownerRoot)
        {
            if (st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax a })
            {
                var chain = Flatten(a.Left);
                return chain.Count == 0 ? "" : chain[chain.Count - 1];
            }
            if (st is ExpressionStatementSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } })
            {
                var chain = Flatten(ma.Expression);
                return chain.Count == 0 ? "" : chain[chain.Count - 1]; // "Controls" of `Controls.Add`
            }
            return "";
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
            // Visual Studio keeps control fields BELOW the generated-code region, after `#endregion` — only the
            // designer's own `components` sits at the top. Follow the last field when one is already down there;
            // otherwise place the first control field just after the region, and fall back to the previous
            // after-the-last-field behavior on a designer file that has no region at all.
            int regionEnd = EndRegionLinePos(text, cls);
            var below = regionEnd >= 0 ? fields.Where(f => f.SpanStart >= regionEnd).ToList() : fields;
            if (below.Count > 0)
            {
                int afterSemi = below[below.Count - 1].Span.End;
                int nlIdx = text.IndexOf('\n', afterSemi);
                pos = nlIdx < 0 ? text.Length : nlIdx + 1;
            }
            else if (regionEnd >= 0)
            {
                // First control field after the region: Visual Studio separates it from `#endregion` by a blank line.
                pos = regionEnd;
                string nl = text.Contains("\r\n") ? "\r\n" : "\n";
                if (!text.Substring(pos).StartsWith(nl, StringComparison.Ordinal)) fieldLine = nl + fieldLine;
            }
            else if (fields.Count > 0)
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

        /// <summary>Position just after the line holding the class's `#endregion` (the end of the designer's
        /// generated-code region), or -1 when the file has none.</summary>
        private static int EndRegionLinePos(string text, ClassDeclarationSyntax cls)
        {
            var directive = cls.DescendantTrivia(descendIntoTrivia: true)
                .Where(t => t.IsKind(SyntaxKind.EndRegionDirectiveTrivia))
                .Select(t => (SyntaxTrivia?)t)
                .LastOrDefault();
            if (directive == null) return -1;
            int nl = text.IndexOf('\n', directive.Value.Span.End);
            return nl < 0 ? text.Length : nl + 1;
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
            // Component ids are interpolated into generated source without an @ prefix. Keep the accepted
            // alphabet deliberately ASCII: it covers the identifiers emitted by Visual Studio while refusing
            // keyword spellings and visually-confusable Unicode (Cyrillic а vs Latin a) at the injection boundary.
            if (!((s[0] >= 'A' && s[0] <= 'Z') || (s[0] >= 'a' && s[0] <= 'z') || s[0] == '_')) return false;
            for (int i = 1; i < s.Length; i++)
                if (!((s[i] >= 'A' && s[i] <= 'Z') || (s[i] >= 'a' && s[i] <= 'z')
                    || (s[i] >= '0' && s[i] <= '9') || s[i] == '_')) return false;
            return SyntaxFacts.GetKeywordKind(s) == SyntaxKind.None && SyntaxFacts.IsValidIdentifier(s);
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
