using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Lives INSIDE a child AppDomain (created by <see cref="DomainManager"/>) whose ApplicationBase is the
    /// user project's output dir, so the DevExpress/PGMUI dependency graph + the app's own .config binding
    /// redirects resolve exactly as they do at runtime. It loads the compiled control assembly and instantiates
    /// the real root control type on a dedicated STA thread (proven by spike S5), then KEEPS that live instance
    /// (per assembly+type) so render / describe / (future) edit all read & mutate the same object — a single
    /// source of truth, so a live edit shows in both the picture and the property grid with no divergence. Only
    /// [Serializable] DTOs cross back to the host; the WinForms work stays confined to this domain.
    /// </summary>
    public sealed class RenderWorker : MarshalByRefObject
    {
        /// <summary>One realized control tree: the off-screen host form, the root control, its type, and the
        /// field-name map (the compiled analogue of a design Site.Name — what .Designer.cs edits target).</summary>
        private sealed class LiveDesign
        {
            public Form Form = default!;
            public Control Root = default!;
            public Type Type = default!;
            public Dictionary<object, string> FieldNames = default!;
            public Dictionary<string, Control> ByField = default!;
        }

        private readonly StaDispatcher _sta = new StaDispatcher();
        private readonly Dictionary<string, LiveDesign> _cache = new Dictionary<string, LiveDesign>(StringComparer.OrdinalIgnoreCase);
        private string[] _probeDirs = Array.Empty<string>();

        // Infinite lease — the host holds this proxy across many calls; without it the remoting lease would
        // expire and later calls would throw RemotingException.
        public override object? InitializeLifetimeService() => null;

        /// <summary>Register the fallback assembly-probe dirs (target bin dir + PGMUI Framework dir). Runs in
        /// THIS (child) domain, so the handler it installs resolves the user's assemblies here.</summary>
        public void Init(string[] probeDirs)
        {
            _probeDirs = probeDirs ?? Array.Empty<string>();
            AppDomain.CurrentDomain.AssemblyResolve += OnResolve;
        }

        private Assembly? OnResolve(object sender, ResolveEventArgs e)
        {
            string simple = new AssemblyName(e.Name).Name;
            foreach (var dir in _probeDirs)
            {
                foreach (var ext in new[] { ".dll", ".exe" })
                {
                    string p = Path.Combine(dir, simple + ext);
                    if (File.Exists(p))
                    {
                        try { return Assembly.LoadFrom(p); } catch { /* keep probing */ }
                    }
                }
            }
            return null;
        }

        /// <summary>Render the (cached) compiled control + build the window-space hit-test map. Geometry matches
        /// the net9 engine's transform so a selection rectangle drawn by the host lines up.</summary>
        public RenderLayoutResult RenderWithLayout(string assemblyPath, string rootTypeName, int reqWidth, int reqHeight)
        {
            return _sta.Invoke(() => Snapshot(GetOrCreate(assemblyPath, rootTypeName, reqWidth, reqHeight)));
        }

        /// <summary>Describe one control of the live instance ("this" = root, else its .Designer.cs field name).
        /// null when the id matches no field-backed control.</summary>
        public ComponentDesc? DescribeComponent(string assemblyPath, string rootTypeName, string componentId)
        {
            return _sta.Invoke(() => DescribeOn(GetOrCreate(assemblyPath, rootTypeName, 0, 0), componentId));
        }

        /// <summary>Apply one property edit to the LIVE instance (via its TypeConverter) and re-render, so the picture
        /// updates immediately for a designer-originated edit. The text write is the host's job (net9 splice); this is
        /// purely the live preview. Best-effort: an unconvertible/read-only value leaves the instance unchanged and
        /// returns Applied=false with a reason (the persisted text edit still shows after a rebuild).</summary>
        public RenderLayoutResult SetPropertyLive(string assemblyPath, string rootTypeName, string componentId, string propName, string rawValue)
        {
            return ApplyEdits(assemblyPath, rootTypeName, new[] { new PropEdit { ComponentId = componentId, PropName = propName, RawValue = rawValue } });
        }

        /// <summary>Apply N property edits to the live instance (each via its TypeConverter) and re-render once —
        /// the batch behind drag/resize/align. Applied=false + a joined reason when any edit couldn't be applied.</summary>
        public RenderLayoutResult ApplyEdits(string assemblyPath, string rootTypeName, PropEdit[] edits)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                var notes = new List<string>();
                foreach (var e in edits)
                {
                    if (!TryApply(live, e.ComponentId ?? "this", e.PropName ?? "", e.RawValue ?? "", out string reason)) notes.Add(reason);
                }
                live.Root.PerformLayout();
                Application.DoEvents();
                var r = Snapshot(live);
                r.Applied = notes.Count == 0;
                if (notes.Count > 0) r.Diagnostics = string.Join("; ", notes);
                return r;
            });
        }

        /// <summary>Remove field-backed controls from the live tree (+ field map) and re-render.</summary>
        public RenderLayoutResult RemoveControls(string assemblyPath, string rootTypeName, string[] ids)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                var notes = new List<string>();
                foreach (var id in ids)
                {
                    if (live.ByField.TryGetValue(id, out var ctl) && ctl.Parent != null)
                    {
                        ctl.Parent.Controls.Remove(ctl);
                        live.ByField.Remove(id);
                        live.FieldNames.Remove(ctl);
                        try { ctl.Dispose(); } catch { /* best effort */ }
                    }
                    else notes.Add("cannot remove '" + id + "'");
                }
                live.Root.PerformLayout();
                Application.DoEvents();
                var r = Snapshot(live);
                r.Applied = notes.Count == 0;
                if (notes.Count > 0) r.Diagnostics = string.Join("; ", notes);
                return r;
            });
        }

        /// <summary>Bring the given field-backed controls to front / send to back (z-order) and re-render.</summary>
        public RenderLayoutResult SetZOrder(string assemblyPath, string rootTypeName, string[] ids, bool toFront)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                foreach (var id in ids)
                {
                    if (live.ByField.TryGetValue(id, out var ctl))
                    {
                        if (toFront) ctl.BringToFront(); else ctl.SendToBack();
                    }
                }
                live.Root.PerformLayout();
                Application.DoEvents();
                return Snapshot(live);
            });
        }

        /// <summary>Instantiate a control of the given type, add it to the parent's Controls at (locX,locY), and
        /// register it under the field name the host generated — so subsequent describe/edit/layout find it. The
        /// persisted declaration + InitializeComponent lines are the host's job (net9); this is the live preview.</summary>
        public RenderLayoutResult AddControl(string assemblyPath, string rootTypeName, string parentId, string controlTypeKey, string newId, int locX, int locY)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                Control? parent = (parentId == "this" || parentId.Length == 0)
                    ? live.Root
                    : (live.ByField.TryGetValue(parentId, out var p) ? p : null);
                if (parent == null) return Note(live, "no parent control '" + parentId + "'");

                Type? ct = ResolveControlType(controlTypeKey);
                if (ct == null) return Note(live, "control type not found: " + controlTypeKey);

                try
                {
                    var ctl = (Control)Activator.CreateInstance(ct);
                    if (!string.IsNullOrEmpty(newId)) ctl.Name = newId;
                    if (locX >= 0 && locY >= 0) ctl.Location = new Point(locX, locY);
                    parent.Controls.Add(ctl);
                    if (!string.IsNullOrEmpty(newId))
                    {
                        live.FieldNames[ctl] = newId;
                        live.ByField[newId] = ctl;
                    }
                    live.Root.PerformLayout();
                    Application.DoEvents();
                    return Snapshot(live);
                }
                catch (Exception ex) { return Note(live, "could not add: " + ex.Message); }
            });
        }

        private RenderLayoutResult Note(LiveDesign live, string reason)
        {
            var r = Snapshot(live);
            r.Applied = false;
            r.Diagnostics = reason;
            return r;
        }

        /// <summary>Resolve a control type by key (FQN or simple name) from the domain's loaded assemblies —
        /// framework controls (System.Windows.Forms) and the user/DevExpress assembly (loaded here). Null if none
        /// is a concrete Control.</summary>
        private static Type? ResolveControlType(string key)
        {
            if (string.IsNullOrEmpty(key)) return null;
            Type? direct = Type.GetType(key, false);
            if (IsConcreteControl(direct)) return direct;
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type? byFull = null;
                try { byFull = a.GetType(key, false); } catch { /* skip */ }
                if (IsConcreteControl(byFull)) return byFull;
            }
            string simple = key.Contains('.') ? key.Substring(key.LastIndexOf('.') + 1) : key;
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = a.GetTypes(); } catch { continue; }
                foreach (var x in types) if (x.Name == simple && IsConcreteControl(x)) return x;
            }
            return null;
        }

        private static bool IsConcreteControl(Type? t) =>
            t != null && !t.IsAbstract && typeof(Control).IsAssignableFrom(t) && t.GetConstructor(Type.EmptyTypes) != null;

        private bool TryApply(LiveDesign live, string componentId, string propName, string rawValue, out string reason)
        {
            reason = "";
            bool isRoot = componentId == "this" || componentId.Length == 0;
            Control? target = isRoot ? live.Root : (live.ByField.TryGetValue(componentId, out var c) ? c : null);
            if (target == null) { reason = "no control '" + componentId + "'"; return false; }
            var pd = TypeDescriptor.GetProperties(target)[propName];
            if (pd == null) { reason = "no property '" + propName + "'"; return false; }
            if (pd.IsReadOnly) { reason = propName + " is read-only"; return false; }
            try
            {
                object? value = pd.Converter != null && pd.Converter.CanConvertFrom(typeof(string))
                    ? pd.Converter.ConvertFromInvariantString(rawValue)
                    : rawValue;
                pd.SetValue(target, value);
                target.PerformLayout();
                return true;
            }
            catch (Exception ex)
            {
                reason = "could not apply '" + rawValue + "' to " + propName + ": " + ex.Message;
                return false;
            }
        }

        private LiveDesign GetOrCreate(string assemblyPath, string rootTypeName, int reqWidth, int reqHeight)
        {
            string key = Path.GetFullPath(assemblyPath) + "|" + rootTypeName;
            if (_cache.TryGetValue(key, out var live)) return live;
            live = Build(assemblyPath, rootTypeName, reqWidth, reqHeight);
            _cache[key] = live;
            return live;
        }

        private LiveDesign Build(string assemblyPath, string rootTypeName, int reqWidth, int reqHeight)
        {
            var diag = new StringBuilder();
            Assembly asm = Assembly.LoadFrom(Path.GetFullPath(assemblyPath));
            Type type = ResolveType(asm, rootTypeName, diag);

            object instance = Activator.CreateInstance(type); // may throw LicenseException (surfaced to host)
            if (!(instance is Control rootCtl))
            {
                throw new InvalidOperationException(rootTypeName + " is not a System.Windows.Forms.Control");
            }

            var fieldNames = BuildFieldNameMap(instance, type);

            var form = new Form
            {
                FormBorderStyle = FormBorderStyle.None,
                ShowInTaskbar = false,
                StartPosition = FormStartPosition.Manual,
                Location = new Point(-20000, -20000), // off-screen, no visible flash
            };
            Size sz = (rootCtl.Size.IsEmpty || rootCtl.Width < 4 || rootCtl.Height < 4) ? new Size(1000, 700) : rootCtl.Size;
            if (reqWidth > 0 && reqHeight > 0) sz = new Size(reqWidth, reqHeight);
            rootCtl.Location = Point.Empty;
            rootCtl.Size = sz;
            form.ClientSize = sz;
            form.Controls.Add(rootCtl);
            form.Show(); // realizes the whole control tree's handles, off-screen

            for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
            rootCtl.PerformLayout();
            Application.DoEvents();

            var byField = new Dictionary<string, Control>(StringComparer.Ordinal);
            foreach (var kv in fieldNames)
            {
                if (kv.Key is Control ctl && !byField.ContainsKey(kv.Value)) byField[kv.Value] = ctl;
            }

            return new LiveDesign { Form = form, Root = rootCtl, Type = type, FieldNames = fieldNames, ByField = byField };
        }

        private RenderLayoutResult Snapshot(LiveDesign live)
        {
            Control root = live.Root;
            int w = Math.Max(root.Width, 1), h = Math.Max(root.Height, 1);
            byte[] png;
            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                root.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
                using (var ms = new MemoryStream())
                {
                    bmp.Save(ms, ImageFormat.Png);
                    png = ms.ToArray();
                }
            }

            var controls = BuildLayoutControls(root, live.Type.Name, live.FieldNames, w, h);
            var tray = BuildTray(live);

            return new RenderLayoutResult
            {
                Png = png,
                Width = w,
                Height = h,
                ClientWidth = root.ClientSize.Width,
                ClientHeight = root.ClientSize.Height,
                RootType = live.Type.FullName ?? live.Type.Name,
                TotalStatements = controls.Count,
                Representable = controls.Count, // compiled render: no interpreted-subset gaps
                Controls = controls,
                Tray = tray,
            };
        }

        private ComponentDesc? DescribeOn(LiveDesign live, string componentId)
        {
            bool isRoot = componentId == "this" || componentId.Length == 0;
            Control? target = isRoot ? live.Root : (live.ByField.TryGetValue(componentId, out var c) ? c : null);
            if (target == null) return null;
            string? parent = isRoot ? null : NearestFieldBackedParent(target, live);
            string name = isRoot ? live.Type.Name : componentId;
            return CompiledDescriber.Describe(target, isRoot ? "this" : componentId, name, isRoot, parent);
        }

        private string? NearestFieldBackedParent(Control c, LiveDesign live)
        {
            for (Control? p = c.Parent; p != null; p = p.Parent)
            {
                if (ReferenceEquals(p, live.Root)) return live.Type.Name;
                string pid = IdOf(p, live.FieldNames);
                if (pid.Length > 0) return pid;
            }
            return null;
        }

        private static Type ResolveType(Assembly asm, string rootTypeName, StringBuilder diag)
        {
            Type t = asm.GetType(rootTypeName, throwOnError: false);
            if (t != null) return t;
            string simple = rootTypeName.Contains('.') ? rootTypeName.Substring(rootTypeName.LastIndexOf('.') + 1) : rootTypeName;
            var byName = asm.GetTypes().Where(x => typeof(Control).IsAssignableFrom(x) && x.Name == simple).ToArray();
            if (byName.Length == 1)
            {
                diag.Append("resolved root by simple name '").Append(simple).Append("'; ");
                return byName[0];
            }
            throw new InvalidOperationException("root type not found in assembly: " + rootTypeName);
        }

        /// <summary>Map each Control/Component instance to the field that holds it — the compiled analogue of the
        /// design surface's Site.Name (exactly what the .Designer.cs edits target: this.&lt;field&gt;.X = ...).</summary>
        private static Dictionary<object, string> BuildFieldNameMap(object instance, Type type)
        {
            var map = new Dictionary<object, string>(ReferenceEqualityComparer.Instance);
            for (Type? t = type; t != null && t != typeof(object); t = t.BaseType)
            {
                foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (!typeof(IComponent).IsAssignableFrom(f.FieldType)) continue;
                    object? val;
                    try { val = f.GetValue(instance); } catch { continue; }
                    if (val != null && !map.ContainsKey(val)) map[val] = f.Name;
                }
            }
            return map;
        }

        private static List<LayoutControl> BuildLayoutControls(Control root, string rootClassName,
            Dictionary<object, string> fieldNames, int frameW, int frameH)
        {
            var all = new List<Control>();
            Collect(root, all);

            var list = new List<LayoutControl>();
            foreach (var ctrl in all)
            {
                bool isRoot = ReferenceEquals(ctrl, root);
                string id = isRoot ? "this" : IdOf(ctrl, fieldNames);
                // Only the controls DECLARED in the .Designer.cs (field-backed) are designer components. Skip the
                // internal sub-parts DevExpress editors build at runtime — they aren't selectable and would swamp
                // the hit-test map. Matches the net9 engine's sited-components-only semantics.
                if (!isRoot && id.Length == 0) continue;

                int depth = 0;
                for (Control? c = ctrl; c != null && !ReferenceEquals(c, root); c = c.Parent) depth++;

                string? parentId = null;
                if (!isRoot)
                {
                    for (Control? p = ctrl.Parent; p != null; p = p.Parent)
                    {
                        if (ReferenceEquals(p, root)) { parentId = "this"; break; }
                        string pid = IdOf(p, fieldNames);
                        if (pid.Length > 0) { parentId = pid; break; }
                    }
                }

                var (x, y) = ComputeWindowOffset(ctrl, root);
                list.Add(new LayoutControl
                {
                    Id = id,
                    Name = isRoot ? rootClassName : id,
                    Type = ctrl.GetType().FullName ?? ctrl.GetType().Name,
                    ParentId = parentId,
                    IsRoot = isRoot,
                    X = isRoot ? 0 : x,
                    Y = isRoot ? 0 : y,
                    Width = isRoot ? frameW : Math.Max(ctrl.Width, 1),
                    Height = isRoot ? frameH : Math.Max(ctrl.Height, 1),
                    Depth = depth,
                    TabIndex = isRoot ? -1 : ctrl.TabIndex,
                    Anchor = isRoot ? "None" : ctrl.Anchor.ToString(),
                    Dock = isRoot ? "None" : ctrl.Dock.ToString(),
                });
            }

            // innermost-first: deepest, then smallest area — host takes the first rect containing the click.
            list.Sort((a, b) =>
            {
                int d = b.Depth.CompareTo(a.Depth);
                if (d != 0) return d;
                return ((long)a.Width * a.Height).CompareTo((long)b.Width * b.Height);
            });
            return list;
        }

        private static void Collect(Control c, List<Control> acc)
        {
            acc.Add(c);
            foreach (Control child in c.Controls) Collect(child, acc);
        }

        private static string IdOf(Control c, Dictionary<object, string> fieldNames)
            => fieldNames.TryGetValue(c, out var n) ? n : "";

        // Same transform as the net9 engine (ComputeWindowOffset). For a UserControl root the chrome is 0.
        private static (int X, int Y) ComputeWindowOffset(Control ctrl, Control root)
        {
            if (ReferenceEquals(ctrl, root)) return (0, 0);
            int x = 0, y = 0;
            for (Control? c = ctrl; c != null && !ReferenceEquals(c, root); c = c.Parent)
            {
                x += c.Left;
                y += c.Top;
            }
            int originX = Math.Max(0, (root.Width - root.ClientSize.Width) / 2);
            int originY = Math.Max(0, (root.Height - root.ClientSize.Height) - originX);
            return (x + originX, y + originY);
        }

        private static List<TrayComponent> BuildTray(LiveDesign live)
        {
            var tray = new List<TrayComponent>();
            var seen = new HashSet<object>(ReferenceEqualityComparer.Instance);
            foreach (var kv in live.FieldNames)
            {
                if (kv.Key is Control) continue;              // controls live in the visual layout
                if (!(kv.Key is IComponent)) continue;
                if (!seen.Add(kv.Key)) continue;
                tray.Add(new TrayComponent { Id = kv.Value, Name = kv.Value, Type = kv.Key.GetType().FullName ?? kv.Key.GetType().Name });
            }
            return tray;
        }

        private sealed class ReferenceEqualityComparer : IEqualityComparer<object>
        {
            public static readonly ReferenceEqualityComparer Instance = new ReferenceEqualityComparer();
            public new bool Equals(object x, object y) => ReferenceEquals(x, y);
            public int GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
        }
    }

    /// <summary>Runs all WinForms work on one persistent STA thread inside the child domain. Mirrors the net9
    /// engine's StaDispatcher.</summary>
    public sealed class StaDispatcher
    {
        private readonly System.Collections.Concurrent.BlockingCollection<Action> _queue =
            new System.Collections.Concurrent.BlockingCollection<Action>();

        public StaDispatcher()
        {
            var t = new Thread(Loop) { IsBackground = true, Name = "winforms-net48-sta" };
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        private void Loop()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            foreach (var action in _queue.GetConsumingEnumerable()) action();
        }

        public T Invoke<T>(Func<T> func)
        {
            T result = default!;
            Exception? error = null;
            using (var done = new ManualResetEventSlim(false))
            {
                _queue.Add(() =>
                {
                    try { result = func(); }
                    catch (Exception ex) { error = ex; }
                    finally { done.Set(); }
                });
                done.Wait();
            }
            if (error != null) throw error; // preserve the original exception (e.g. LicenseException) for the host
            return result;
        }
    }
}
