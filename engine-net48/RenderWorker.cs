using System;
using System.Collections;
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
    /// user project's output dir, so the DevExpress dependency graph + the app's own .config binding
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
            /// <summary>1.0.0 fail-closed — identity of THIS compiled instance, stamped once at construction and
            /// reported to the host on every response (<see cref="RenderLayoutResult.LiveInstanceId"/>).
            ///
            /// net48 renders a live compiled INSTANCE, never the .Designer.cs text, so the host can only trust the
            /// picture while it knows the instance still carries the buffer's unsaved edits. The host cannot infer
            /// that: an instance is replaced by an explicit DiscardLive, by an engine crash, by a control-source
            /// change (different cache key), by hot-exit recovery — and, invisibly to the host, by DomainManager
            /// unloading the whole AppDomain when it notices the target assembly was rebuilt. Every one of those
            /// reaches the host as a fresh id, which is the ONE fact it needs: a new id means this picture came from
            /// the assembly, so if the buffer is dirty the two have provably parted company.
            ///
            /// A GUID, not a counter: DomainManager builds a brand-new worker per AppDomain, so a per-worker counter
            /// would restart at the same value and read as "unchanged" across exactly the replacement it must catch.</summary>
            public string InstanceId = Guid.NewGuid().ToString("N");
            /// <summary>1.0.0 fail-closed — identity of the BUILD this instance was created from: the compiled
            /// assembly's last-write time + length. Distinct from InstanceId, which changes on every (re)instantiation
            /// (a discard/release reload keeps the SAME build). The host needs both: a new InstanceId on the SAME
            /// BuildId means the picture reloaded from the same stale build (still divergent from unbuilt source edits),
            /// whereas a new BuildId means the user actually rebuilt, which is the only thing that re-syncs the preview.
            /// Cheap + robust (no hashing); a rebuild always changes at least the timestamp.</summary>
            public string BuildId = "";
            /// <summary>How this tree was built: "compiled" (the last build — default), "interpreted"
            /// (the live source via the IR interpreter), or "compiledFallback". Snapshot stamps it on the result.</summary>
            public string Mode = "compiled";
            /// <summary>Stable RenderFallbackReason when Mode=="compiledFallback"; "" otherwise.</summary>
            public string FallbackReason = "";
            /// <summary>The LOGICAL designed type name reported as RootType. Null on the compiled path (Type is the
            /// designed type there); set on the interpreted path, where Type is the instantiated BASE type.</summary>
            public string? DesignedTypeName = null;
        }

        /// <summary>The build identity the host compares across renders — see <see cref="LiveDesign.BuildId"/>.
        /// "0:0" when the file can't be stat'd (treated as an unknown, never-advancing build).</summary>
        private static string ComputeBuildId(string assemblyPath)
        {
            try
            {
                var fi = new FileInfo(Path.GetFullPath(assemblyPath));
                return fi.LastWriteTimeUtc.Ticks + ":" + fi.Length;
            }
            catch { return "0:0"; }
        }

        private readonly StaDispatcher _sta = new StaDispatcher();

        // Integer DPI capture scale for the picture (1 = logical, 2 = 4K@200%…). Set by the full-render entry points and
        // reused by every Snapshot (incl. live-op re-renders) so the whole session stays crisp at the display's ratio.
        private int _renderScale = 1;
        private readonly Dictionary<string, LiveDesign> _cache = new Dictionary<string, LiveDesign>(StringComparer.OrdinalIgnoreCase);
        private string[] _probeDirs = Array.Empty<string>();

        // Infinite lease — the host holds this proxy across many calls; without it the remoting lease would
        // expire and later calls would throw RemotingException.
        public override object? InitializeLifetimeService() => null;

        /// <summary>Register the fallback assembly-probe dirs (target bin dir + any user-configured vendor dirs; see
        /// Program.ComputeProbes). Runs in THIS (child) domain, so the handler it installs resolves the user's
        /// assemblies here.</summary>
        public void Init(string[] probeDirs)
        {
            _probeDirs = probeDirs ?? Array.Empty<string>();
            AppDomain.CurrentDomain.AssemblyResolve += OnResolve;
        }

        private Assembly? OnResolve(object sender, ResolveEventArgs e)
        {
            string simple = new AssemblyName(e.Name).Name;
            // Our OWN engine assembly (defining the [Serializable] DTOs PropEdit/LiveCollItem/… that cross the
            // remoting boundary) was loaded into this child domain by PATH via CreateInstanceFromAndUnwrap, i.e.
            // in the LoadFrom context — a cross-domain deserialization's Assembly.Load(fullName) looks in the
            // (fixture's) ApplicationBase + GAC and won't find it, throwing "Type is not resolved for member …".
            // Resolve it to the already-loaded instance so any DTO array (SetCollectionLive / ApplyEdits) round-trips.
            var self = typeof(RenderWorker).Assembly;
            if (string.Equals(simple, self.GetName().Name, StringComparison.OrdinalIgnoreCase)) return self;
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
        public RenderLayoutResult RenderWithLayout(string assemblyPath, string rootTypeName, int reqWidth, int reqHeight, int renderScale = 1)
        {
            _renderScale = renderScale;
            return _sta.Invoke(() => Snapshot(GetOrCreate(assemblyPath, rootTypeName, reqWidth, reqHeight)));
        }

        /// <summary>Render the LIVE .Designer.cs source via the IR interpreter (VS model: instantiate
        /// the immediate BASE type, replay the parsed statements onto it against the project's COMPILED control
        /// types), or FALL BACK to the compiled last build with a named reason when the interpreter can't fully cover
        /// the form. Always returns a picture; RenderMode ("interpreted" | "compiledFallback") + FallbackReason tell
        /// the host which it got. NOT cached — it reflects the exact source buffer on every call (the whole point).</summary>
        public RenderLayoutResult RenderInterpretedWithLayout(string designerFilePath, string assemblyPath, IrDocument? doc,
            string rootTypeName, int reqWidth, int reqHeight, string[]? selectedTabs = null, int renderScale = 1)
        {
            _renderScale = renderScale;
            return _sta.Invoke(() =>
            {
                Assembly asm;
                try { asm = Assembly.LoadFrom(Path.GetFullPath(assemblyPath)); }
                catch (Exception ex)
                {
                    return CompiledFallback(assemblyPath, rootTypeName, reqWidth, reqHeight,
                        RenderFallbackReason.ExecutorFailure, "assembly load: " + ex.Message);
                }

                // NOTE: `doc` was parsed by Roslyn in the DEFAULT domain and marshaled here (it is [Serializable]) —
                // Roslyn never loads in this child domain. This method only resolves compiled types + runs
                // the executor, no parsing.
                //
                // FAIL-CLOSED + DETERMINISTIC TEARDOWN. The container holds
                // every sited component; a Form realized off-screen holds the whole HWND/GDI tree. This render is NOT
                // cached (it must reflect the exact source buffer each call), so nothing outlives the snapshot — the
                // `finally` disposes the Form, any partly-built root, and the container (reverse-order, incl. a target
                // left BeginInit'd). And ANY failure after the assembly loads (executor throw, a forged/edge doc that
                // trips the coverage classifier, the Control cast, layout, or paint) degrades to the DISCLOSED compiled
                // fallback, never a hard RPC error: the method's contract is "always return a picture; RenderMode +
                // FallbackReason say which".
                var container = new DesignTimeContainer();
                var host = new AssemblyIrHost(ProbeAssembliesFor(asm), container, LoadSiblingResx(designerFilePath));
                Form? builtForm = null;
                InterpretedRenderPlan? plan = null;
                try
                {
                    // Resolve the BASE type from the COMPILED designed type's BaseType — the reliable source, since a VS
                    // form declares its base in the NON-designer partial the parsed .Designer.cs never contains. A source
                    // that changed the base since the last build shows up as a mismatch → stale-type handshake → fallback.
                    Type? baseType = null;
                    var designedType = asm.GetType(rootTypeName, throwOnError: false);
                    if (designedType != null)
                    {
                        baseType = designedType.BaseType;
                        if (doc != null && baseType != null && !string.IsNullOrEmpty(doc.BaseTypeSyntaxName)
                            && !SameBase(doc.BaseTypeSyntaxName, baseType))
                        {
                            return CompiledFallback(assemblyPath, rootTypeName, reqWidth, reqHeight,
                                RenderFallbackReason.BaseTypeChanged,
                                "source base '" + doc.BaseTypeSyntaxName + "' != compiled base '" + baseType.FullName + "' (rebuild)");
                        }
                    }

                    plan = InterpretedRenderPlan.Plan(doc, host, baseType);
                    if (!plan.Interpreted)
                    {
                        return CompiledFallback(assemblyPath, rootTypeName, reqWidth, reqHeight,
                            plan.Decision.FallbackReason ?? RenderFallbackReason.ExecutorFailure, plan.Decision.Detail ?? "");
                    }

                    var rootCtl = (Control)plan.Root!;
                    ApplyTabViewState(plan.Execution!, selectedTabs); // transient selected-tab override
                    builtForm = HostOffscreen(rootCtl, reqWidth, reqHeight);
                    for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
                    rootCtl.PerformLayout();
                    Application.DoEvents();

                    var exec = plan.Execution!;
                    // FieldNames = the interpreter's own name→instance table inverted (the analogue of the reflection map),
                    // which already merges inherited base components + current-source ones (hybrid identity).
                    var fieldNames = new Dictionary<object, string>(ReferenceEqualityComparer.Instance);
                    foreach (var kv in exec.Instances)
                        if (kv.Key.Length != 0 && !fieldNames.ContainsKey(kv.Value)) fieldNames[kv.Value] = kv.Key;
                    var byField = new Dictionary<string, Control>(StringComparer.Ordinal);
                    foreach (var kv in fieldNames)
                        if (kv.Key is Control c && !byField.ContainsKey(kv.Value)) byField[kv.Value] = c;

                    var live = new LiveDesign
                    {
                        Form = builtForm,
                        Root = rootCtl,
                        Type = rootCtl.GetType(),
                        FieldNames = fieldNames,
                        ByField = byField,
                        BuildId = ComputeBuildId(assemblyPath),
                        Mode = "interpreted",
                        DesignedTypeName = plan.DesignedTypeName,
                    };
                    return Snapshot(live);
                }
                catch (Exception ex)
                {
                    return CompiledFallback(assemblyPath, rootTypeName, reqWidth, reqHeight,
                        RenderFallbackReason.ExecutorFailure, "interpreted render: " + ex.Message);
                }
                finally
                {
                    // Snapshot has already drawn the tree to PNG + geometry (it keeps no live reference), so tearing the
                    // graph down here runs AFTER the result is computed. Best-effort — a teardown failure must not mask it.
                    try { builtForm?.Dispose(); } catch { /* cascades to the realized child-control HWND/GDI tree */ }
                    try { if (builtForm == null && plan?.Root is IDisposable d) d.Dispose(); } catch { /* partly-built root on a late fallback */ }
                    try { container.Dispose(); } catch { /* reverse-order dispose of every sited component */ }
                }
            });
        }

        /// <summary>Render the compiled last build and stamp it as a disclosed fallback (the interpreter couldn't
        /// cover this form). Reuses the exact compiled path so a fallback is byte-identical to a plain compiled render.</summary>
        private RenderLayoutResult CompiledFallback(string assemblyPath, string rootTypeName, int w, int h, string reason, string detail)
        {
            var r = Snapshot(GetOrCreate(assemblyPath, rootTypeName, w, h));
            r.RenderMode = "compiledFallback";
            r.FallbackReason = reason ?? "";
            if (!string.IsNullOrEmpty(detail)) r.Diagnostics = detail;
            return r;
        }

        /// <summary>describe one component of the INTERPRETED live-source instance (not the
        /// compiled build), so the property panel matches the interpreted canvas on an unsaved edit. Builds a
        /// REQUEST-LOCAL interpreted graph (the same lifecycle as RenderInterpretedWithLayout — host/show/layout so
        /// parity-grade property values realize, then fail-closed dispose in finally), resolves the target + its
        /// reference-dropdown siblings ONLY through the executor's identity model (Instances + Origins), and describes
        /// via CompiledDescriber. Returns null when the form doesn't fully interpret or the id names no current
        /// component — the host then leaves the panel UNAVAILABLE (it must NEVER substitute compiled values under an
        /// interpreted canvas). NOT cached, like the interpreted render.</summary>
        public ComponentDesc? DescribeInterpretedComponent(string designerFilePath, string assemblyPath, IrDocument? doc,
            string rootTypeName, string componentId, int reqWidth, int reqHeight)
        {
            return _sta.Invoke(() =>
            {
                Assembly asm;
                try { asm = Assembly.LoadFrom(Path.GetFullPath(assemblyPath)); } catch { return (ComponentDesc?)null; }
                var container = new DesignTimeContainer();
                var host = new AssemblyIrHost(ProbeAssembliesFor(asm), container, LoadSiblingResx(designerFilePath));
                Form? builtForm = null;
                InterpretedRenderPlan? plan = null;
                try
                {
                    var designedType = asm.GetType(rootTypeName, throwOnError: false);
                    Type? baseType = designedType?.BaseType;
                    // Stale-base handshake (parity with RenderInterpretedWithLayout): a source whose base changed since the
                    // last build must NOT be replayed onto the stale compiled base — describe returns null (panel
                    // unavailable), exactly as render falls back rather than describing the wrong graph.
                    if (doc != null && baseType != null && !string.IsNullOrEmpty(doc.BaseTypeSyntaxName)
                        && !SameBase(doc.BaseTypeSyntaxName, baseType))
                        return null;
                    plan = InterpretedRenderPlan.Plan(doc, host, baseType);
                    if (!plan.Interpreted || plan.Execution == null) return null; // not interpreted → panel stays unavailable
                    var rootCtl = (Control)plan.Root!;
                    builtForm = HostOffscreen(rootCtl, reqWidth, reqHeight);
                    for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
                    rootCtl.PerformLayout();
                    Application.DoEvents();
                    return DescribeInterpretedOn(plan, rootCtl, componentId ?? "");
                }
                catch { return null; }
                finally
                {
                    try { builtForm?.Dispose(); } catch { }
                    try { if (builtForm == null && plan?.Root is IDisposable d) d.Dispose(); } catch { }
                    try { container.Dispose(); } catch { }
                }
            });
        }

        /// <summary>Describe a target resolved ONLY from the interpreter's identity model. Root
        /// ("" / "this") → the LOGICAL designed type's short name (NOT the base runtime type); a named component →
        /// Execution.Instances[id]. Reference-dropdown siblings are the current-source components
        /// (Origins == DeclaredInCurrentSource) — the ones the derived .Designer.cs can actually spell as this.&lt;field&gt;
        /// — never reflection over the base-type runtime root (which would surface the wrong base fields). An
        /// inherited/absent target returns null (the host keeps that selection read-only/unavailable).</summary>
        private ComponentDesc? DescribeInterpretedOn(InterpretedRenderPlan plan, Control root, string componentId)
        {
            // Identity-model resolution (target + current-source siblings + logical root/parent) lives in the shared,
            // unit-tested InterpretedDescribeResolver; a null result means the id is inherited/unknown → the panel stays
            // unavailable. The one net48-only step — turning the resolved target into a ComponentDesc through the real
            // TypeDescriptor — stays here.
            var t = InterpretedDescribeResolver.Resolve(plan.Execution!, plan.DesignedTypeName, root, componentId);
            if (t == null) return null;
            return CompiledDescriber.Describe(t.Target, t.IsRoot ? "this" : componentId, t.Name, t.IsRoot, t.Parent, t.Siblings, root);
        }

        /// <summary>the INTERPRETED analogue of HitTestTab: which tab page's header is under the
        /// window-space point, hit-tested against the LIVE-SOURCE geometry (not the compiled build). Builds a
        /// request-local interpreted graph (applying the current tab view-state so the header layout matches what the
        /// user sees), resolves the host TabControl from the identity model, and GetTabRect-hit-tests it via the shared
        /// PageAt. PageId "" when off a header / not interpretable / the id isn't a tab host. Fail-closed dispose.</summary>
        public TabHit HitTestInterpretedTab(string designerFilePath, string assemblyPath, IrDocument? doc, string rootTypeName,
            string hostId, int winX, int winY, string[]? selectedTabs)
        {
            return _sta.Invoke(() =>
            {
                Assembly asm;
                try { asm = Assembly.LoadFrom(Path.GetFullPath(assemblyPath)); } catch { return new TabHit(); }
                var container = new DesignTimeContainer();
                var host = new AssemblyIrHost(ProbeAssembliesFor(asm), container, LoadSiblingResx(designerFilePath));
                Form? builtForm = null;
                InterpretedRenderPlan? plan = null;
                try
                {
                    var baseType = asm.GetType(rootTypeName, throwOnError: false)?.BaseType;
                    plan = InterpretedRenderPlan.Plan(doc, host, baseType);
                    if (!plan.Interpreted || plan.Execution == null) return new TabHit();
                    var rootCtl = (Control)plan.Root!;
                    ApplyTabViewState(plan.Execution, selectedTabs);
                    builtForm = HostOffscreen(rootCtl, 0, 0);
                    for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
                    rootCtl.PerformLayout();
                    Application.DoEvents();
                    Control? hostCtl = (hostId == "this" || hostId.Length == 0)
                        ? rootCtl
                        : (plan.Execution.Instances.TryGetValue(hostId, out var h) && h is Control hc ? hc : null);
                    if (hostCtl == null) return new TabHit();
                    var (hx, hy) = ComputeWindowOffset(hostCtl, rootCtl);
                    var page = PageAt(hostCtl, winX - hx, winY - hy);
                    if (page == null) return new TabHit();
                    string pid = "";
                    foreach (var kv in plan.Execution.Instances)
                        if (kv.Key.Length != 0 && ReferenceEquals(kv.Value, page)) { pid = kv.Key; break; }
                    return new TabHit { PageId = pid, Text = page.Text ?? "" };
                }
                catch { return new TabHit(); }
                finally
                {
                    try { builtForm?.Dispose(); } catch { }
                    try { if (builtForm == null && plan?.Root is IDisposable d) d.Dispose(); } catch { }
                    try { container.Dispose(); } catch { }
                }
            });
        }

        private static IEnumerable<Assembly> ProbeAssembliesFor(Assembly userAsm) => new[]
        {
            userAsm, typeof(Control).Assembly, typeof(Color).Assembly, typeof(Point).Assembly,
            typeof(ISupportInitialize).Assembly, typeof(object).Assembly,
        };

        private static SafeResxResolver LoadSiblingResx(string designerFilePath)
        {
            try
            {
                if (!string.IsNullOrEmpty(designerFilePath))
                {
                    const string suffix = ".Designer.cs";
                    string resx = designerFilePath.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
                        ? designerFilePath.Substring(0, designerFilePath.Length - suffix.Length) + ".resx"
                        : Path.ChangeExtension(designerFilePath, ".resx");
                    // Size cap: a sibling .resx is repository-controlled input read into an XML DOM on
                    // every render — bound it so a hostile/pathological multi-hundred-MB .resx can't exhaust memory.
                    // 32 MiB is far above any real form's string table yet well below an OOM. Over-cap → empty (fail
                    // closed): any GetString/GetObject then falls back, exactly as for a refused node.
                    const long MaxResxBytes = 32L << 20;
                    if (File.Exists(resx) && new FileInfo(resx).Length <= MaxResxBytes)
                        return SafeResxResolver.Parse(File.ReadAllText(resx));
                }
            }
            catch { /* fall through to empty (fail closed) */ }
            return SafeResxResolver.Parse("");
        }

        /// <summary>apply transient tab VIEW STATE: set each named TabControl's SelectedTab to the
        /// named TabPage so a tab-click stays interpreted (the source's SelectedIndex is overridden by the user's
        /// navigation, re-supplied on every render since the interpreted graph is uncached). NARROW, allowlisted adapter:
        /// ONLY System.Windows.Forms.TabControl + TabPage resolved from the executor's identity model — a vendor tab type
        /// or an unresolvable/foreign page is a NO-OP (interpreted tab-nav for those is disabled, never guessed). Each
        /// entry is "hostFieldName=pageFieldName".</summary>
        private static void ApplyTabViewState(IrExecutionResult exec, string[]? selectedTabs)
        {
            if (selectedTabs == null) return;
            foreach (var pair in selectedTabs)
            {
                int eq = pair?.IndexOf('=') ?? -1;
                if (eq <= 0) continue;
                string hostName = pair!.Substring(0, eq);
                string pageName = pair.Substring(eq + 1);
                if (exec.Instances.TryGetValue(hostName, out var h) && h is TabControl tc
                    && exec.Instances.TryGetValue(pageName, out var p) && p is TabPage tp && tc.TabPages.Contains(tp))
                    try { tc.SelectedTab = tp; } catch { /* a bad view-state is a no-op, never a throw */ }
            }
        }

        /// <summary>Realize a root control off-screen so its handle tree (and vendor skinning) initializes exactly as
        /// at runtime — a Form hosted directly, any other Control wrapped in a borderless host form (mirrors Build).</summary>
        private static Form HostOffscreen(Control rootCtl, int reqWidth, int reqHeight)
        {
            Form form;
            if (rootCtl is Form rootForm)
            {
                rootForm.StartPosition = FormStartPosition.Manual;
                rootForm.ShowInTaskbar = false;
                rootForm.Location = new Point(-20000, -20000);
                if (reqWidth > 0 && reqHeight > 0) rootForm.ClientSize = new Size(reqWidth, reqHeight);
                form = rootForm;
            }
            else
            {
                form = new Form
                {
                    FormBorderStyle = FormBorderStyle.None,
                    ShowInTaskbar = false,
                    StartPosition = FormStartPosition.Manual,
                    Location = new Point(-20000, -20000),
                };
                Size sz = (rootCtl.Size.IsEmpty || rootCtl.Width < 4 || rootCtl.Height < 4) ? new Size(1000, 700) : rootCtl.Size;
                if (reqWidth > 0 && reqHeight > 0) sz = new Size(reqWidth, reqHeight);
                rootCtl.Location = Point.Empty;
                rootCtl.Size = sz;
                form.ClientSize = sz;
                form.Controls.Add(rootCtl);
            }
            // Show realizes the handle tree; if a vendor OnHandleCreated/OnLayout throws, dispose the WRAPPER Form we own
            // (the Form-root case disposes via the caller's plan.Root) so a throwing control can't leak a Form/HWND per
            // render/describe call lost the wrapper on throw).
            try { form.Show(); }
            catch { if (!ReferenceEquals(form, rootCtl)) { try { form.Dispose(); } catch { } } throw; }
            return form;
        }

        /// <summary>Whether the source's declared base name refers to the same type as the compiled base. A QUALIFIED
        /// source base (has a namespace) must match the FULL name — a short-name match across DIFFERENT namespaces
        /// (OldVendor.BaseForm vs NewVendor.BaseForm) is a real base change, not a match, and must NOT be silently
        /// rendered from the stale compiled base. A short-name match is only trusted for an UNQUALIFIED
        /// source base (a `using`-imported name the front-end can't fully qualify). A false mismatch merely forces a
        /// safe compiled fallback.</summary>
        private static bool SameBase(string sourceBaseSyntax, Type compiledBase)
        {
            if (sourceBaseSyntax == compiledBase.FullName) return true;
            if (sourceBaseSyntax.IndexOf('.') >= 0) return false; // qualified → require full-name equality
            return sourceBaseSyntax == compiledBase.Name; // unqualified → short-name match is all we have
        }

        /// <summary>Describe one control of the live instance ("this" = root, else its .Designer.cs field name).
        /// null when the id matches no field-backed control.</summary>
        public ComponentDesc? DescribeComponent(string assemblyPath, string rootTypeName, string componentId)
        {
            return _sta.Invoke(() => DescribeOn(GetOrCreate(assemblyPath, rootTypeName, 0, 0), componentId));
        }

        /// <summary>The vendor smart-tag menu a component's compiled type DECLARES (DevExpress "Tasks") — read
        /// only, never invoked; see VendorSmartTags for why. [] for a plain framework control, an unknown id, or any
        /// failure, so the host simply shows no vendor section.</summary>
        public VendorSmartTag[] ListVendorSmartTags(string assemblyPath, string rootTypeName, string componentId)
        {
            return _sta.Invoke(() =>
            {
                try
                {
                    var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                    var target = ResolveLiveTarget(live, componentId);
                    return target == null ? Array.Empty<VendorSmartTag>() : VendorSmartTags.Read(target);
                }
                catch { return Array.Empty<VendorSmartTag>(); }
            });
        }

        /// <summary>Apply one property edit to the LIVE instance (via its TypeConverter) and re-render, so the picture
        /// updates immediately for a designer-originated edit. The text write is the host's job (net9 splice); this is
        /// purely the live preview. Best-effort: an unconvertible/read-only value leaves the instance unchanged and
        /// returns Applied=false with a reason (the persisted text edit still shows after a rebuild).</summary>
        public RenderLayoutResult SetPropertyLive(string assemblyPath, string rootTypeName, string componentId, string propName, string rawValue)
        {
            return ApplyEdits(assemblyPath, rootTypeName, new[] { new PropEdit { ComponentId = componentId, PropName = propName, RawValue = rawValue } });
        }

        /// <summary>Reset ONE property on the live instance to its default (pd.ResetValue) and re-render — the picture
        /// half of a per-property Reset. The persisted text delete is the host's job (net9 splice). Applied=false + a
        /// reason only when the property can't be resolved / is read-only / throws; a property with nothing to reset
        /// (CanResetValue==false) is a benign success (the source delete still persists).</summary>
        public RenderLayoutResult ResetPropertyLive(string assemblyPath, string rootTypeName, string componentId, string propName)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                var notes = new List<string>();
                if (!TryReset(live, componentId ?? "this", propName ?? "", out string reason)) notes.Add(reason);
                live.Root.PerformLayout();
                Application.DoEvents();
                var r = Snapshot(live);
                r.Applied = notes.Count == 0;
                if (notes.Count > 0) r.Diagnostics = string.Join("; ", notes);
                return r;
            });
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

        /// <summary>Reconstruct a typed collection (string Items / ListView.Columns / DataGridView.Columns) on the LIVE
        /// instance from the same item data the net9 text editor committed, then re-render — so the net48 canvas shows
        /// the edit immediately instead of the built collection (T1.1b; the persisted text is the net9 splice's truth).
        /// The live collection is fully rebuilt (Clear + typed Add): the item DTO carries no concrete column type, so
        /// new/rebuilt columns use the default type (ColumnHeader / DataGridViewTextBoxColumn) — the real typed columns
        /// return from source on rebuild. Best-effort: any failure (bound/read-only collection) leaves the picture on
        /// the built collection and returns Applied=false + a reason (host surfaces "renders fully after a rebuild").</summary>
        public RenderLayoutResult SetCollectionLive(string assemblyPath, string rootTypeName, string componentId, string propName, string itemType, LiveCollItem[] items)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                bool isRoot = componentId == "this" || componentId.Length == 0;
                Control? owner = isRoot ? live.Root : (live.ByField.TryGetValue(componentId, out var c) ? c : null);
                if (owner == null) return Note(live, "no control '" + componentId + "'");
                try
                {
                    // Resolve the collection property via TypeDescriptor (mirrors TryApply/TryReset): its indexer returns
                    // the most-derived descriptor and never throws AmbiguousMatchException on a `new`-shadowed property
                    // (e.g. CheckedListBox re-declares Items) — a raw reflection GetProperty(name) would. The collection
                    // (Items/Columns) is read-only, so mutate it in place (don't SetValue). Kept INSIDE the try so a
                    // lookup/getter throw becomes an honest Applied=false note (previewPartial) instead of an RPC error.
                    var pd = TypeDescriptor.GetProperties(owner)[propName];
                    object? coll = pd?.GetValue(owner);
                    if (coll == null) return Note(live, "no collection '" + propName + "' on " + componentId);
                    switch (itemType)
                    {
                        case "System.String": RebuildStringItems(coll, items); break;
                        case "System.Windows.Forms.ColumnHeader": RebuildListColumns(coll, items); break;
                        case "System.Windows.Forms.DataGridViewColumn": RebuildGridColumns(coll, items); break;
                        default: return Note(live, "unsupported collection item type: " + itemType);
                    }
                    live.Root.PerformLayout();
                    Application.DoEvents();
                    return Snapshot(live);
                }
                // unwrap TargetInvocationException / a bound-collection InvalidOperationException so the note is honest
                catch (Exception ex) { return Note(live, "could not update " + propName + ": " + ex.GetBaseException().Message); }
            });
        }

        /// <summary>Rebuild a ListBox/ComboBox/CheckedListBox ObjectCollection (IList) to exactly the given strings.</summary>
        private static void RebuildStringItems(object coll, LiveCollItem[] items)
        {
            var list = (IList)coll; // ObjectCollection implements IList
            list.Clear();
            foreach (var it in items) list.Add(it.Text ?? "");
        }

        /// <summary>Rebuild a ListView.ColumnHeaderCollection (IList) to exactly the given columns (default type
        /// ColumnHeader — the item DTO carries no concrete type; the typed source columns return on rebuild).</summary>
        private static void RebuildListColumns(object coll, LiveCollItem[] items)
        {
            var list = (IList)coll; // ColumnHeaderCollection implements IList
            list.Clear();
            foreach (var it in items)
            {
                var ch = new ColumnHeader { Text = it.Text ?? "" };
                ch.Width = it.Width; // set verbatim: 0 hides the column, -1/-2 are size-to-content/header sentinels — the
                                     // host always sends the committed width, so honor it (don't clamp or skip 0)
                if (!string.IsNullOrEmpty(it.Align) && Enum.TryParse(it.Align, out HorizontalAlignment ha)) ch.TextAlign = ha;
                if (!string.IsNullOrEmpty(it.Id)) ch.Name = it.Id;
                list.Add(ch);
            }
        }

        /// <summary>Rebuild a DataGridViewColumnCollection to exactly the given columns (default type
        /// DataGridViewTextBoxColumn — the item DTO carries no concrete type; the typed source columns return on rebuild).</summary>
        private static void RebuildGridColumns(object coll, LiveCollItem[] items)
        {
            var cols = (DataGridViewColumnCollection)coll;
            cols.Clear(); // throws if the grid is data-bound → caught by the caller (Applied=false)
            foreach (var it in items)
            {
                var col = new DataGridViewTextBoxColumn { HeaderText = it.Text ?? "", ReadOnly = it.ReadOnly, Visible = it.Visible };
                if (!string.IsNullOrEmpty(it.Id)) col.Name = it.Id; // DataGridView.Columns is keyed by Name
                // Width below MinimumWidth throws; a bad width shouldn't nuke the whole rebuild → soft-set.
                if (it.Width > 0) { try { col.Width = it.Width; } catch { /* keep the type default */ } }
                cols.Add(col);
            }
        }

        /// <summary>Set a generic string[] property (TextBox/RichTextBox.Lines) on the LIVE instance from the same
        /// values the net9 text editor committed, then re-render — so the net48 canvas shows the edit immediately
        /// instead of the built value (the persisted text is the net9 splice's truth). Unlike
        /// <see cref="SetCollectionLive"/> (in-place Clear/Add on a read-only collection), a string[] property has a
        /// real setter, so a FRESH array is assigned via pd.SetValue. Best-effort: a missing/read-only/non-string[]
        /// property leaves the picture on the built value and returns Applied=false + a reason (host surfaces
        /// "renders fully after a rebuild").</summary>
        public RenderLayoutResult SetStringArrayLive(string assemblyPath, string rootTypeName, string componentId, string propName, string[] values)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                bool isRoot = componentId == "this" || componentId.Length == 0;
                Control? owner = isRoot ? live.Root : (live.ByField.TryGetValue(componentId, out var c) ? c : null);
                if (owner == null) return Note(live, "no control '" + componentId + "'");
                try
                {
                    // TypeDescriptor indexer → most-derived descriptor (never AmbiguousMatchException on a `new`-shadowed
                    // property). Guard type + writability so a mismatch is an honest Applied=false note, not an RPC error.
                    var pd = TypeDescriptor.GetProperties(owner)[propName];
                    if (pd == null) return Note(live, "no property '" + propName + "' on " + componentId);
                    if (pd.IsReadOnly || pd.PropertyType != typeof(string[]))
                        return Note(live, propName + " on " + componentId + " is not a writable string[]");
                    pd.SetValue(owner, values ?? new string[0]);
                    live.Root.PerformLayout();
                    Application.DoEvents();
                    return Snapshot(live);
                }
                catch (Exception ex) { return Note(live, "could not update " + propName + ": " + ex.GetBaseException().Message); }
            });
        }

        /// <summary>Reconstruct a TreeView's Nodes (the recursive analogue of <see cref="SetCollectionLive"/>) on the
        /// LIVE compiled instance from the same node forest the net9 text editor committed, then re-render — so the
        /// net48 canvas shows the node edit immediately instead of the built tree (the net48 live node picture; the
        /// persisted text is the net9 splice's truth). The live TreeNodeCollection is fully rebuilt (Clear + typed
        /// Add) with fresh TreeNode objects carrying only Text (ctor label) + Name (key) — the same subset the read
        /// side round-trips, so an image/checkbox node never arrives here. Nodes stay collapsed, matching the
        /// compiled rebuild baseline (a runtime TreeView doesn't auto-expand — the net9 interpreter doesn't either).
        /// Best-effort: a non-<see cref="System.Windows.Forms.TreeNodeCollection"/> Nodes (a DevExpress TreeList) or
        /// any failure leaves the picture on the built tree and returns Applied=false + a reason (host surfaces
        /// "renders fully after a rebuild").</summary>
        /// <summary>Replace a live compiled ImageList's images from the already self-verified ImageStream payload and
        /// re-render immediately. The persisted .resx/designer transaction is owned by the host; this method changes
        /// only the cached preview instance so net48 has the same immediate reconciliation as other collections.</summary>
        public RenderLayoutResult SetImageListLive(string assemblyPath, string rootTypeName, string componentId,
            string imageStreamBase64, string[] keys)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                if (!(ResolveLiveTarget(live, componentId) is ImageList target))
                    return Note(live, "no ImageList '" + componentId + "'");
                var decoded = ImageListSerializer.Deserialize(imageStreamBase64 ?? "");
                if (!decoded.Ok) return Note(live, "could not decode ImageList: " + decoded.Reason);
                try
                {
                    target.Images.Clear();
                    if (decoded.Width > 0 && decoded.Height > 0)
                        target.ImageSize = new Size(decoded.Width, decoded.Height);
                    if (Enum.TryParse(decoded.ColorDepth, out ColorDepth depth)) target.ColorDepth = depth;
                    if (!string.IsNullOrWhiteSpace(decoded.TransparentColor))
                        target.TransparentColor = Color.FromName(decoded.TransparentColor);
                    for (int i = 0; i < decoded.Images.Length; i++)
                    {
                        byte[] bytes = Convert.FromBase64String(decoded.Images[i].DataBase64 ?? "");
                        using (var stream = new MemoryStream(bytes, writable: false))
                        using (var source = Image.FromStream(stream, useEmbeddedColorManagement: false, validateImageData: true))
                        using (var owned = new Bitmap(source))
                        {
                            string key = i < (keys?.Length ?? 0) ? (keys[i] ?? "") : (decoded.Images[i].Key ?? "");
                            if (key.Length == 0) target.Images.Add(owned);
                            else target.Images.Add(key, owned);
                        }
                    }
                    live.Root.PerformLayout();
                    Application.DoEvents();
                    return Snapshot(live);
                }
                catch (Exception ex) { return Note(live, "could not update ImageList: " + ex.GetBaseException().Message); }
            });
        }

        public RenderLayoutResult SetTreeNodesLive(string assemblyPath, string rootTypeName, string componentId, string propName, LiveTreeNode[] nodes)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                bool isRoot = componentId == "this" || componentId.Length == 0;
                Control? owner = isRoot ? live.Root : (live.ByField.TryGetValue(componentId, out var c) ? c : null);
                if (owner == null) return Note(live, "no control '" + componentId + "'");
                try
                {
                    // Resolve the collection via TypeDescriptor (mirrors SetCollectionLive): its indexer returns the
                    // most-derived descriptor and never throws AmbiguousMatchException on a `new`-shadowed property.
                    var pd = TypeDescriptor.GetProperties(owner)[propName];
                    object? coll = pd?.GetValue(owner);
                    if (coll == null) return Note(live, "no collection '" + propName + "' on " + componentId);
                    // Only a genuine WinForms TreeNodeCollection is rebuildable this way. A DevExpress TreeList exposes a
                    // differently-typed Nodes (virtual/data-bound TreeListNode); rebuilding it is out of scope → honest note.
                    if (!(coll is System.Windows.Forms.TreeNodeCollection tnc))
                        return Note(live, propName + " is not a TreeNodeCollection on " + componentId);
                    RebuildTreeNodes(tnc, nodes ?? Array.Empty<LiveTreeNode>());
                    live.Root.PerformLayout();
                    Application.DoEvents();
                    return Snapshot(live);
                }
                // unwrap TargetInvocationException / a read-only-collection InvalidOperationException so the note is honest
                catch (Exception ex) { return Note(live, "could not update " + propName + ": " + ex.GetBaseException().Message); }
            });
        }

        /// <summary>Rebuild a live TreeNodeCollection to exactly the given forest (Clear + recursive typed Add). Each
        /// node is a fresh <see cref="System.Windows.Forms.TreeNode"/> with Text (label) + optional Name (key); its
        /// children recurse into that node's own Nodes. Text/Name only — matching the net9 editor's round-trip subset.</summary>
        private static void RebuildTreeNodes(System.Windows.Forms.TreeNodeCollection coll, LiveTreeNode[] nodes)
        {
            coll.Clear();
            foreach (var n in nodes) coll.Add(BuildLiveTreeNode(n));
        }

        /// <summary>Build one live TreeNode (Text + optional Name + image props) and recurse into its children. The
        /// image is drawn by WinForms from the compiled TreeView's ImageList once set. ImageKey/ImageIndex are mutually
        /// exclusive (setting one clears the other) — apply key-first, else index-if->=0, per pair.</summary>
        private static System.Windows.Forms.TreeNode BuildLiveTreeNode(LiveTreeNode n)
        {
            var node = new System.Windows.Forms.TreeNode(n.Text ?? "");
            if (!string.IsNullOrEmpty(n.Name)) node.Name = n.Name;
            if (!string.IsNullOrEmpty(n.ImageKey)) node.ImageKey = n.ImageKey;
            else if (n.ImageIndex >= 0) node.ImageIndex = n.ImageIndex;
            if (!string.IsNullOrEmpty(n.SelectedImageKey)) node.SelectedImageKey = n.SelectedImageKey;
            else if (n.SelectedImageIndex >= 0) node.SelectedImageIndex = n.SelectedImageIndex;
            if (!string.IsNullOrEmpty(n.ToolTipText)) node.ToolTipText = n.ToolTipText;
            if (n.Checked) node.Checked = n.Checked;
            // visual-style props — the invariant string (matching the net9 editor / property grid) becomes a live
            // Color/Font via the framework TypeConverter; a bad value is skipped rather than aborting the render.
            var fore = ConvertInvariant<System.Drawing.Color?>(n.ForeColor); if (fore.HasValue) node.ForeColor = fore.Value;
            var back = ConvertInvariant<System.Drawing.Color?>(n.BackColor); if (back.HasValue) node.BackColor = back.Value;
            var font = ConvertInvariant<System.Drawing.Font>(n.NodeFont); if (font != null) node.NodeFont = font;
            if (n.Children != null)
                foreach (var child in n.Children) node.Nodes.Add(BuildLiveTreeNode(child));
            return node;
        }

        /// <summary>Parse a property-grid invariant string into a live framework value (Color/Font) via its
        /// TypeConverter; returns default(T) on empty/unparseable input so a bad node style never aborts the render.</summary>
        private static T ConvertInvariant<T>(string invariant)
        {
            if (string.IsNullOrEmpty(invariant)) return default(T);
            try
            {
                var target = Nullable.GetUnderlyingType(typeof(T)) ?? typeof(T);
                var conv = System.ComponentModel.TypeDescriptor.GetConverter(target);
                if (conv == null || !conv.CanConvertFrom(typeof(string))) return default(T);
                var v = conv.ConvertFromInvariantString(invariant);
                return v is T typed ? typed : default(T);
            }
            catch { return default(T); }
        }

        /// <summary>Apply an add/remove/rename/reorder of a ToolStrip/MenuStrip's items to the LIVE compiled instance
        /// from the net9-committed item forest, then re-render — so the net48 canvas shows the menu edit immediately
        /// instead of the built strip (the net9 splice is the persisted truth). Unlike TreeView.Nodes, ToolStrip items
        /// are PERSISTED FIELDS carrying unmodelled props (Image, event wiring), so the collection is reconciled
        /// SURGICALLY keyed by the designer field id (from the field map, else ToolStripItem.Name): an existing item
        /// object is reused (only its Text changes on a rename), a new item is constructed once, deletions are disposed
        /// — never Clear()+rebuild, which would drop those props. The host resolves every id (incl. minted ids for
        /// "Type Here" adds) before calling, so an empty id never reaches here. Best-effort: a non-ToolStrip owner or
        /// an unresolvable new item type leaves the picture on the built strip and returns Applied=false + a reason
        /// (host surfaces "renders after a rebuild"); the strip's own OnPaint redraws the mutated Items during the
        /// snapshot's DrawToBitmap, so no explicit item walk is needed.</summary>
        public RenderLayoutResult SetToolStripItemsLive(string assemblyPath, string rootTypeName, string componentId, LiveToolStripItem[] items)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                bool isRoot = componentId == "this" || componentId.Length == 0;
                Control? owner = isRoot ? live.Root : (live.ByField.TryGetValue(componentId, out var c) ? c : null);
                if (owner == null) return Note(live, "no control '" + componentId + "'");
                if (!(owner is ToolStrip strip)) return Note(live, "'" + componentId + "' is not a ToolStrip");
                try
                {
                    // Phase 1 (pure): build the per-collection reconciliation plans — reuse existing item objects,
                    // construct new ones (into memory, NOT yet added), record renames — WITHOUT touching the live
                    // collections. An unresolvable new-item type throws here, before any mutation, so a failure leaves
                    // the picture untouched (honest Applied=false via the catch).
                    var plans = new List<ToolStripColPlan>();
                    var renames = new List<KeyValuePair<ToolStripItem, string>>();
                    var registers = new List<KeyValuePair<ToolStripItem, string>>();
                    BuildToolStripPlan(strip.Items, items ?? Array.Empty<LiveToolStripItem>(), live, plans, renames, registers);

                    // Phase 2 (apply): register newly-built items in the field map (tray/describe parity + stable
                    // matching on the next live edit), rebuild each collection to its exact order (Clear detaches
                    // without disposing, so reused items keep their props), dispose deletions, apply deferred renames.
                    foreach (var reg in registers) live.FieldNames[reg.Key] = reg.Value;
                    foreach (var p in plans)
                    {
                        // Prune each deletion's WHOLE subtree from the field map BEFORE disposing it: a deleted
                        // ToolStripDropDownItem is never recursed by BuildToolStripPlan (only reused items are), so its
                        // children have no ColPlan — and Dispose() cascade-disposes them. Without this walk their
                        // FieldNames entries would linger as phantom disposed items (tray/describe leak). Mirrors
                        // RemoveTab's Collect(page, subtree) descendant cleanup.
                        foreach (var del in p.Deletions) RemoveItemFieldEntries(del, live);
                        p.Coll.Clear();
                        foreach (var it in p.Ordered) p.Coll.Add(it);
                        foreach (var del in p.Deletions) { try { del.Dispose(); } catch { /* best effort */ } }
                    }
                    foreach (var rn in renames) rn.Key.Text = rn.Value;

                    live.Root.PerformLayout();
                    Application.DoEvents();
                    return Snapshot(live);
                }
                catch (Exception ex) { return Note(live, "could not update items on " + componentId + ": " + ex.GetBaseException().Message); }
            });
        }

        /// <summary>One reconciled collection: the live ToolStripItemCollection, the exact ordered item objects it
        /// should contain (reused + newly built), and the items to remove/dispose.</summary>
        private sealed class ToolStripColPlan
        {
            public ToolStripItemCollection Coll = default!;
            public List<ToolStripItem> Ordered = new List<ToolStripItem>();
            public List<ToolStripItem> Deletions = new List<ToolStripItem>();
        }

        /// <summary>Recursively PLAN the reconciliation of one ToolStripItemCollection against the desired item list,
        /// keyed by designer field id. Reuses the matching live item object (recursing into its DropDownItems);
        /// constructs a fresh item for an id with no live match (a "Type Here" add — always a leaf, per the net9
        /// editor). Mutates nothing — plans/renames/registers are collected for the caller to apply.</summary>
        private void BuildToolStripPlan(ToolStripItemCollection coll, LiveToolStripItem[] desired, LiveDesign live,
            List<ToolStripColPlan> plans, List<KeyValuePair<ToolStripItem, string>> renames, List<KeyValuePair<ToolStripItem, string>> registers)
        {
            var byId = new Dictionary<string, ToolStripItem>(StringComparer.Ordinal);
            foreach (ToolStripItem it in coll)
            {
                string iid = ToolStripItemId(it, live);
                if (iid.Length > 0 && !byId.ContainsKey(iid)) byId[iid] = it;
            }

            var ordered = new List<ToolStripItem>();
            foreach (var d in desired ?? Array.Empty<LiveToolStripItem>())
            {
                string did = d.Id ?? "";
                if (did.Length > 0 && byId.TryGetValue(did, out var existing))
                {
                    // reuse the existing item object (keeps its Image/event/other props); rename Text if it changed
                    if (!(existing is ToolStripSeparator) && !string.IsNullOrEmpty(d.Text) && existing.Text != d.Text)
                        renames.Add(new KeyValuePair<ToolStripItem, string>(existing, d.Text));
                    if (existing is ToolStripDropDownItem ddi)
                        BuildToolStripPlan(ddi.DropDownItems, d.Children ?? Array.Empty<LiveToolStripItem>(), live, plans, renames, registers);
                    ordered.Add(existing);
                }
                else
                {
                    // no live match → a new item (its minted field id is already in `did`). New items are leaves.
                    Type? t = ResolveToolStripItemType(d.ItemType);
                    if (t == null) throw new InvalidOperationException("unknown ToolStrip item type '" + (d.ItemType ?? "") + "'");
                    var obj = (ToolStripItem)Activator.CreateInstance(t);
                    if (did.Length > 0) { obj.Name = did; registers.Add(new KeyValuePair<ToolStripItem, string>(obj, did)); }
                    if (!(obj is ToolStripSeparator) && !string.IsNullOrEmpty(d.Text)) obj.Text = d.Text;
                    ordered.Add(obj);
                }
            }

            var deletions = new List<ToolStripItem>();
            foreach (ToolStripItem it in coll)
                if (!ordered.Any(o => ReferenceEquals(o, it))) deletions.Add(it);

            plans.Add(new ToolStripColPlan { Coll = coll, Ordered = ordered, Deletions = deletions });
        }

        /// <summary>The designer field id of a live ToolStrip item — the field-map name (the compiled analogue of
        /// Site.Name) or, for an item this session created live (not a compiled field), its Name. Matches the net9
        /// editor's identity, so a source item whose .Name assignment is absent still resolves via the field map.</summary>
        private static string ToolStripItemId(ToolStripItem item, LiveDesign live)
            => (live.FieldNames.TryGetValue(item, out var fn) && fn.Length > 0) ? fn : (item.Name ?? "");

        /// <summary>Remove a deleted item AND its whole DropDownItems subtree from the field map — call BEFORE Dispose()
        /// (which cascade-disposes the descendants) while DropDownItems is still intact, so no phantom disposed entries
        /// linger in FieldNames (→ BuildTray). The recursion depth is bounded by the live tree, never the input.</summary>
        private static void RemoveItemFieldEntries(ToolStripItem item, LiveDesign live)
        {
            live.FieldNames.Remove(item);
            if (item is ToolStripDropDownItem ddi)
                foreach (ToolStripItem child in ddi.DropDownItems)
                    RemoveItemFieldEntries(child, live);
        }

        /// <summary>The 10 item types a NEW item may be constructed as — the same allowlist the net9 editor gates adds
        /// by. Existing items are never re-created, so a vendor item type never needs to resolve here.</summary>
        private static readonly Dictionary<string, string> _toolStripItemFqns = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            { "ToolStripMenuItem", "System.Windows.Forms.ToolStripMenuItem" },
            { "ToolStripButton", "System.Windows.Forms.ToolStripButton" },
            { "ToolStripLabel", "System.Windows.Forms.ToolStripLabel" },
            { "ToolStripSeparator", "System.Windows.Forms.ToolStripSeparator" },
            { "ToolStripComboBox", "System.Windows.Forms.ToolStripComboBox" },
            { "ToolStripTextBox", "System.Windows.Forms.ToolStripTextBox" },
            { "ToolStripDropDownButton", "System.Windows.Forms.ToolStripDropDownButton" },
            { "ToolStripSplitButton", "System.Windows.Forms.ToolStripSplitButton" },
            { "ToolStripProgressBar", "System.Windows.Forms.ToolStripProgressBar" },
            { "ToolStripStatusLabel", "System.Windows.Forms.ToolStripStatusLabel" },
        };

        /// <summary>Resolve a NEW item's short type name to a concrete ToolStripItem type from the allowlist (default
        /// ToolStripMenuItem when empty). Returns null for an unknown/non-item/abstract type so the caller degrades to
        /// Applied=false rather than constructing an arbitrary type.</summary>
        private static Type? ResolveToolStripItemType(string shortName)
        {
            if (string.IsNullOrEmpty(shortName)) return typeof(ToolStripMenuItem);
            if (!_toolStripItemFqns.TryGetValue(shortName, out var fqn)) return null;
            Type? t = typeof(ToolStripItem).Assembly.GetType(fqn, false);
            return (t != null && !t.IsAbstract && typeof(ToolStripItem).IsAssignableFrom(t)) ? t : null;
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
                // unwrap TargetInvocationException (Activator.CreateInstance) so the note names the real ctor failure
                catch (Exception ex) { return Note(live, "could not add: " + ex.GetBaseException().Message); }
            });
        }

        /// <summary>Enumerate the project/vendor assembly's own toolbox-eligible controls — the net48 counterpart of
        /// the net9 engine's EnumerateProjectControls, for the DevExpress/net4x assemblies the net9 enumerator can't
        /// load. Loads the assembly in THIS child domain (dependencies resolve via the probe handler installed in
        /// <see cref="Init"/>), reflects eligible Control types into [Serializable] DTOs (name / fqn / [ToolboxBitmap]
        /// icon) — NO instantiation, GetTypes()/attributes only — and returns them for the host to merge with the net9
        /// framework palette under "Project Controls". Fully guarded: returns [] on any failure (degrade to
        /// framework-only), never throws across the domain boundary.</summary>
        public ToolboxItemInfo[] ListToolboxControls(string assemblyPath)
        {
            return _sta.Invoke(() =>
            {
                try
                {
                    var asm = Assembly.LoadFrom(Path.GetFullPath(assemblyPath));
                    Type[] types;
                    try { types = asm.GetTypes(); }
                    catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray()!; }
                    var list = new List<ToolboxItemInfo>();
                    foreach (var t in types)
                    {
                        if (t == null) continue;
                        try
                        {
                            if (!IsEligibleToolboxControl(t)) continue;
                            list.Add(new ToolboxItemInfo
                            {
                                Name = t.Name,
                                Fqn = t.FullName!,
                                Category = "Project Controls",
                                FromProject = true,
                                IconPng = ToolboxIconPng(t),
                            });
                        }
                        catch { /* a type that throws on reflection is simply skipped */ }
                    }
                    return list.GroupBy(i => i.Fqn, StringComparer.Ordinal).Select(g => g.First())
                               .OrderBy(i => i.Name, StringComparer.Ordinal).ToArray();
                }
                catch { return Array.Empty<ToolboxItemInfo>(); }
            });
        }

        /// <summary>Toolbox-eligibility for a project/vendor control type — a faithful mirror of the net9 engine's
        /// DesignerControlEditor.IsEligibleToolboxControl so both engines offer the same set: public, concrete,
        /// parameterless-ctor, Control-derived, a valid Controls.Add target (Form / ToolStripDropDown menus
        /// excluded — they throw if parented), not [ToolboxItem(false)] / [DesignTimeVisible(false)], and not a
        /// base/utility/editing-helper type.</summary>
        private static bool IsEligibleToolboxControl(Type t)
        {
            if (!t.IsPublic || !t.IsClass || t.IsAbstract || t.IsGenericTypeDefinition || t.IsNested) return false;
            if (!typeof(Control).IsAssignableFrom(t)) return false;
            if (typeof(Form).IsAssignableFrom(t) || typeof(ToolStripDropDown).IsAssignableFrom(t)) return false;
            if (t.GetConstructor(Type.EmptyTypes) == null) return false;
            if (IsToolboxDisabled(t) || IsDesignTimeInvisible(t)) return false;
            if (ToolboxBaseDenylist.Contains(t.Name) || t.Name.EndsWith("EditingControl", StringComparison.Ordinal)) return false;
            if (string.IsNullOrEmpty(t.FullName) || t.FullName!.IndexOf('+') >= 0) return false;
            return true;
        }

        private static readonly HashSet<string> ToolboxBaseDenylist = new HashSet<string>(StringComparer.Ordinal)
        { "Control", "ContainerControl", "ScrollableControl", "UserControl" };

        /// <summary>True when the type carries [ToolboxItem(false)] (read via CustomAttributeData so it doesn't
        /// depend on which assembly defines the attribute; only the bool-ctor form disables).</summary>
        private static bool IsToolboxDisabled(Type t)
        {
            foreach (var a in t.GetCustomAttributesData())
            {
                if (a.AttributeType.Name != "ToolboxItemAttribute") continue;
                if (a.ConstructorArguments.Count == 1 && a.ConstructorArguments[0].Value is bool b) return !b;
            }
            return false;
        }

        /// <summary>True when the type carries [DesignTimeVisible(false)] — the "hidden from toolbox / tray" marker.</summary>
        private static bool IsDesignTimeInvisible(Type t)
        {
            foreach (var a in t.GetCustomAttributesData())
            {
                if (a.AttributeType.Name != "DesignTimeVisibleAttribute") continue;
                if (a.ConstructorArguments.Count == 1 && a.ConstructorArguments[0].Value is bool b) return !b;
            }
            return false;
        }

        /// <summary>The control type's 16×16 [ToolboxBitmap] icon as a base64 PNG (the icon VS shows in the palette),
        /// or null when none is embedded / extraction fails. Fully guarded: any failure degrades to no icon.</summary>
        private static string? ToolboxIconPng(Type t)
        {
            try
            {
                var tba = (System.Drawing.ToolboxBitmapAttribute?)
                    System.ComponentModel.TypeDescriptor.GetAttributes(t)[typeof(System.Drawing.ToolboxBitmapAttribute)];
                using (var img = tba?.GetImage(t, false)) // small (16×16) variant
                {
                    if (img == null) return null;
                    using (var bmp = new Bitmap(img))
                    using (var ms = new MemoryStream())
                    {
                        bmp.Save(ms, ImageFormat.Png);
                        return Convert.ToBase64String(ms.ToArray());
                    }
                }
            }
            catch { return null; }
        }

        private RenderLayoutResult Note(LiveDesign live, string reason)
        {
            var r = Snapshot(live);
            r.Applied = false;
            r.Diagnostics = reason;
            return r;
        }

        /// <summary>Add a new empty tab page (type pageTypeFqn) to the tab host, register it under newId, make it the
        /// active page, and re-render. Reflective TabPages.Add + SelectedTab set (covers WinForms + DevExpress).</summary>
        public RenderLayoutResult AddTab(string assemblyPath, string rootTypeName, string hostId, string pageTypeFqn, string newId)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                Control? host = (hostId == "this" || hostId.Length == 0)
                    ? live.Root
                    : (live.ByField.TryGetValue(hostId, out var h) ? h : null);
                if (host == null) return Note(live, "no tab host '" + hostId + "'");
                var pagesProp = FindTabProp(host.GetType(), "TabPages");
                if (pagesProp == null) return Note(live, "not a tab host: " + hostId);
                Type? pt = ResolveControlType(pageTypeFqn);
                if (pt == null) return Note(live, "tab page type not found: " + pageTypeFqn);
                try
                {
                    var page = (Control)Activator.CreateInstance(pt);
                    if (!string.IsNullOrEmpty(newId)) { page.Name = newId; page.Text = newId; }
                    var coll = pagesProp.GetValue(host);
                    var add = coll?.GetType().GetMethods().FirstOrDefault(m =>
                        m.Name == "Add" && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsInstanceOfType(page));
                    if (coll == null || add == null) return Note(live, "tab collection has no Add(page)");
                    add.Invoke(coll, new object[] { page });
                    if (!string.IsNullOrEmpty(newId)) { live.FieldNames[page] = newId; live.ByField[newId] = page; }
                    // make the new tab active so it's the one shown
                    var selProp = FindTabProp(host.GetType(), "SelectedTabPage", "SelectedPage", "SelectedTab");
                    if (selProp != null && selProp.CanWrite) { try { selProp.SetValue(host, page); } catch { /* best effort */ } }
                    live.Root.PerformLayout();
                    Application.DoEvents();
                    return Snapshot(live);
                }
                catch (Exception ex) { return Note(live, "could not add tab: " + ex.Message); }
            });
        }

        /// <summary>Remove tab page <paramref name="pageId"/> from tab host <paramref name="hostId"/> on the LIVE
        /// instance — detach it from the host's TabPages collection (WinForms + DevExpress) or its Parent.Controls —
        /// drop the page's whole subtree from the field maps, dispose it, and re-render. Applied=false when the page
        /// isn't a live child. The PERSISTED removal is the host's net9 text edit; this just updates the picture.</summary>
        public RenderLayoutResult RemoveTab(string assemblyPath, string rootTypeName, string hostId, string pageId)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                Control? host = (hostId == "this" || hostId.Length == 0)
                    ? live.Root
                    : (live.ByField.TryGetValue(hostId, out var h) ? h : null);
                if (host == null) return Note(live, "no tab host '" + hostId + "'");
                if (!live.ByField.TryGetValue(pageId, out var page) || page == null) return Note(live, "no tab page '" + pageId + "'");
                var subtree = new List<Control>();
                Collect(page, subtree); // page + descendants — captured BEFORE detach/dispose while Controls is intact
                if (!TryRemoveTabPage(host, page)) return Note(live, "could not remove tab '" + pageId + "'");
                foreach (var c in subtree)
                    if (live.FieldNames.TryGetValue(c, out var fid)) { live.ByField.Remove(fid); live.FieldNames.Remove(c); }
                try { page.Dispose(); } catch { /* best effort */ }
                live.Root.PerformLayout();
                Application.DoEvents();
                var r = Snapshot(live);
                r.Applied = true;
                return r;
            });
        }

        /// <summary>Detach a tab page from its host: prefer the host's TabPages collection Remove (covers WinForms
        /// TabControl + DevExpress XtraTabControl via reflection), else the page's Parent.Controls.Remove. True when
        /// the page was removed.</summary>
        private static bool TryRemoveTabPage(Control host, Control page)
        {
            var coll = FindTabProp(host.GetType(), "TabPages")?.GetValue(host);
            if (coll != null)
            {
                var remove = coll.GetType().GetMethods().FirstOrDefault(m =>
                    m.Name == "Remove" && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsInstanceOfType(page));
                if (remove != null)
                {
                    try { remove.Invoke(coll, new object[] { page }); return true; }
                    catch { /* fall back to Parent.Controls */ }
                }
            }
            if (page.Parent != null)
            {
                try { page.Parent.Controls.Remove(page); return true; }
                catch { /* best effort */ }
            }
            return false;
        }

        /// <summary>Switch the active tab of the tab host <paramref name="hostId"/> to whichever tab HEADER contains
        /// the window-space point (winX,winY), then re-render. Uses the host's own hit-testing (DevExpress
        /// XtraTabControl.CalcHitInfo → .Page, or WinForms TabControl.GetTabRect + SelectedIndex). Applied=false and
        /// no change when the point isn't on the header of a DIFFERENT tab, so a normal click still selects the
        /// control instead of consuming the gesture.</summary>
        public RenderLayoutResult SelectTabAt(string assemblyPath, string rootTypeName, string hostId, int winX, int winY)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                Control? host = (hostId == "this" || hostId.Length == 0)
                    ? live.Root
                    : (live.ByField.TryGetValue(hostId, out var h) ? h : null);
                if (host == null) return Note(live, "no tab host '" + hostId + "'");
                var (hx, hy) = ComputeWindowOffset(host, live.Root);
                if (!TrySelectTabAt(host, winX - hx, winY - hy)) { var s = Snapshot(live); s.Applied = false; return s; }
                live.Root.PerformLayout();
                Application.DoEvents();
                var r = Snapshot(live);
                r.Applied = true;
                return r;
            });
        }

        /// <summary>Return the tab page (its .Designer.cs field id + current Text) whose header is under the
        /// window-space point on the tab host <paramref name="hostId"/> — the host uses it to rename a tab (edit that
        /// page's Text). PageId is "" when the point isn't on a header (or the page isn't field-backed).</summary>
        public TabHit HitTestTab(string assemblyPath, string rootTypeName, string hostId, int winX, int winY)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                Control? host = (hostId == "this" || hostId.Length == 0)
                    ? live.Root
                    : (live.ByField.TryGetValue(hostId, out var h) ? h : null);
                if (host == null) return new TabHit();
                var (hx, hy) = ComputeWindowOffset(host, live.Root);
                var page = PageAt(host, winX - hx, winY - hy);
                if (page == null) return new TabHit();
                return new TabHit { PageId = IdOf(page, live.FieldNames), Text = page.Text ?? "" };
            });
        }

        /// <summary>True when the control looks like a tab host: it exposes a TabPages collection AND a
        /// SelectedTab/SelectedTabPage/SelectedPage property (covers WinForms TabControl + DevExpress XtraTabControl,
        /// via reflection — the net48 engine doesn't reference DevExpress at compile time).</summary>
        /// <summary>Find a public non-indexer property by name via a GetProperties() SCAN instead of
        /// Type.GetProperty(name), which throws AmbiguousMatchException when the property is `new`-shadowed with a
        /// covariant return across the inheritance chain — exactly the DevExpress pattern PageAt already works around
        /// for its .Page property. The scan is behaviorally identical for a singly-declared property (plain WinForms
        /// TabControl) and only diverges by RETURNING the shadowed property instead of THROWING (which the callers'
        /// try/catch would swallow → the tab feature silently disappears for XtraTabControl). Names are tried in order,
        /// mirroring a `GetProperty(a) ?? GetProperty(b)` chain.</summary>
        private static System.Reflection.PropertyInfo? FindTabProp(Type t, params string[] names)
        {
            foreach (var n in names)
                foreach (var p in t.GetProperties())
                    if (p.Name == n && p.GetIndexParameters().Length == 0) return p;
            return null;
        }

        private static bool LooksLikeTabHost(Control c)
        {
            try
            {
                var t = c.GetType();
                return FindTabProp(t, "TabPages") != null
                    && FindTabProp(t, "SelectedTabPage", "SelectedPage", "SelectedTab") != null;
            }
            catch { return false; }
        }

        /// <summary>The tab PAGE whose header contains the control-local point, or null. DevExpress:
        /// CalcHitInfo(Point).Page (its "Page" prop can be shadowed by a `new` re-declaration → GetProperty throws
        /// Ambiguous, so scan GetProperties); WinForms: GetTabRect(i) → TabPages[i]. Reflection-only (no DevExpress
        /// compile-time reference). Any failure → null.</summary>
        private static Control? PageAt(Control host, int localX, int localY)
        {
            var pt = new Point(localX, localY);
            var t = host.GetType();
            var calc = t.GetMethod("CalcHitInfo", new[] { typeof(Point) });
            if (calc != null)
            {
                try
                {
                    var hit = calc.Invoke(host, new object[] { pt });
                    var pageProp = hit?.GetType().GetProperties().FirstOrDefault(p => p.Name == "Page" && p.GetIndexParameters().Length == 0);
                    return pageProp?.GetValue(hit) as Control;
                }
                catch { return null; }
            }
            if (host is System.Windows.Forms.TabControl tc)
            {
                for (int i = 0; i < tc.TabCount; i++)
                    try { if (tc.GetTabRect(i).Contains(pt)) return tc.TabPages[i]; } catch { /* skip */ }
            }
            return null;
        }

        /// <summary>Select the tab page whose header is at the control-local point. True only when the active page
        /// actually CHANGED (so a body/active-header click stays a no-op and normal selection runs instead).</summary>
        private static bool TrySelectTabAt(Control host, int localX, int localY)
        {
            var page = PageAt(host, localX, localY);
            if (page == null) return false;
            var t = host.GetType();
            var selProp = FindTabProp(t, "SelectedTabPage", "SelectedPage", "SelectedTab");
            if (selProp == null || !selProp.CanWrite) return false;
            try
            {
                var before = selProp.GetValue(host);
                if (ReferenceEquals(before, page)) return false; // header of the already-active tab
                selProp.SetValue(host, page);
                return !ReferenceEquals(selProp.GetValue(host), before);
            }
            catch { return false; }
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
            // Simple-name fallback ONLY for a bare key (a toolbox short name like "Button"). A DOTTED FQN that failed
            // to resolve above must NOT silently rebind to a same-short-name type in another assembly — a crafted
            // paste clip could otherwise steer TypeName to an unintended concrete Control (arbitrary enumeration
            // order picks the first match). A dotted-but-unresolvable name returns null instead.
            if (key.Contains('.')) return null;
            foreach (var a in AppDomain.CurrentDomain.GetAssemblies())
            {
                Type[] types;
                try { types = a.GetTypes(); } catch { continue; }
                foreach (var x in types) if (x.Name == key && IsConcreteControl(x)) return x;
            }
            return null;
        }

        private static bool IsConcreteControl(Type? t) =>
            t != null && !t.IsAbstract && typeof(Control).IsAssignableFrom(t) && t.GetConstructor(Type.EmptyTypes) != null;

        private bool TryApply(LiveDesign live, string componentId, string propName, string rawValue, out string reason)
        {
            reason = "";
            // Resolve broadly (a control via ByField, else any field-backed component via the FieldNames reverse-scan),
            // THEN gate the edit TARGET selectively. The assign-only reference branch below is safe on ANY component
            // owner (it stores a sibling as a value, never runs the component), so a tray-component reference —
            // notifyIcon1.ContextMenuStrip, errorProvider1.ContainerControl — is live-editable. Every OTHER edit stays
            // restricted to a Control or ToolStripItem (ResolveLiveEditTarget's contract): a non-Control non-item
            // component (a Timer) must NOT be live-mutated, or e.g. Timer.Enabled=true would Start() it and the render
            // pump would dispatch its compiled Tick handler inside the preview. A control/item hits the same instances
            // ByField/reverse-scan, so its path is byte-identical.
            IComponent? target = ResolveLiveTarget(live, componentId);
            if (target == null) { reason = "no control '" + componentId + "'"; return false; }
            var pd = TypeDescriptor.GetProperties(target)[propName];
            if (pd == null) { reason = "no property '" + propName + "'"; return false; }
            if (pd.IsReadOnly) { reason = propName + " is read-only"; return false; }
            bool isRef = IsFrameworkReferenceConverter(pd.Converter);
            // Only a reference edit may target a non-Control non-item component; anything else stays inert (Timer gate).
            if (!isRef && !(target is Control || target is ToolStripItem)) { reason = "no control '" + componentId + "'"; return false; }
            // A REFERENCE edit on a ToolStripItem is refused: describe EXCLUDES ToolStripItem owners from reference
            // dropdowns (CompiledDescriber.ReferenceValuesOf: the item channel can't translate a reference pick), so the
            // host never offers one. Mirror that exclusion on the write side too, so a direct RPC/CLI caller bypassing the
            // host's referenceValues re-validation can't set a reference the describe side never advertises — keeping
            // offer ⇔ accept exact for items (covers both a sibling and the new "(this)" root token). Non-reference item
            // edits (Text/Enabled/… — the item→Properties path) are unaffected: they take the !isRef branch above.
            if (isRef && target is ToolStripItem) { reason = propName + " reference edits are not supported on a ToolStripItem"; return false; }
            try
            {
                object? value;
                // Component-reference property (ReferenceConverter: AcceptButton/CancelButton/ContextMenuStrip…): its
                // converter can't parse a field name into an instance without a design container, so resolve the name
                // ourselves — "(none)"/"" → null (clear); else `this.<field>` or `<field>` → the live sibling instance
                // (via the SAME resolver describe/edit share). We only ASSIGN the sibling as a value, never mutate it,
                // so a non-Control component reference (a ContextMenuStrip) is safe (unlike the edit-TARGET gate).
                if (isRef)
                {
                    if (rawValue == CompiledDescriber.ReferenceNone || rawValue.Length == 0)
                    {
                        value = null;
                    }
                    else
                    {
                        // The synthetic "(this)" token → the live ROOT form (describe offers it whenever the root is
                        // assignable to the property, e.g. ErrorProvider.ContainerControl = this). Every other token is a
                        // this.<field> sibling name resolved via the shared resolver.
                        string refName = rawValue == CompiledDescriber.ReferenceThis ? "this"
                            : (rawValue.StartsWith("this.") ? rawValue.Substring(5) : rawValue);
                        var inst = rawValue == CompiledDescriber.ReferenceThis ? live.Root : ResolveLiveTarget(live, refName);
                        if (inst == null) { reason = "no component '" + refName + "' to reference from " + propName; return false; }
                        // Mirror the describe candidate set exactly, so a direct RPC/CLI caller bypassing the host's
                        // referenceValues re-validation can't assign a reference the dropdown never offers. The ROOT form is
                        // NOW an offered candidate (the "(this)" token) whenever it is assignable, so it is no longer
                        // rejected here — the assignability check below is the SAME gate describe uses to offer root, so the
                        // two sides can never diverge (offer-root ⟺ accept-root). Still reject a component referencing
                        // ITSELF: describe never offers it, yet a self-typed prop would be assignable (defense
                        // in depth; the host never sends a non-candidate).
                        if (ReferenceEquals(inst, target))
                        { reason = "cannot reference itself from " + propName + " (not an offered candidate)"; return false; }
                        // Explicit assignability check (don't rely on SetValue throwing): the host validates the pick
                        // against the describe candidate list, but a direct RPC/CLI caller might request an incompatible
                        // sibling (or a root the property can't hold) — reject it, mirroring the describe-side filter.
                        if (!pd.PropertyType.IsInstanceOfType(inst)) { reason = refName + " is not assignable to " + propName; return false; }
                        value = inst;
                    }
                }
                else
                {
                    value = pd.Converter != null && pd.Converter.CanConvertFrom(typeof(string))
                        ? pd.Converter.ConvertFromInvariantString(rawValue)
                        : rawValue;
                }
                pd.SetValue(target, value);
                RelayoutTarget(target);
                return true;
            }
            catch (Exception ex)
            {
                reason = "could not apply '" + rawValue + "' to " + propName + ": " + ex.Message;
                return false;
            }
        }

        /// <summary>True for a framework <see cref="System.ComponentModel.ReferenceConverter"/> (or a WinForms subclass) —
        /// the converter a component-reference property carries. Gated on the framework assembly so a third-party
        /// ReferenceConverter subclass does not hit the field-name reference resolve. Mirrors the describe-side gate.</summary>
        private static bool IsFrameworkReferenceConverter(TypeConverter? conv)
        {
            if (!(conv is System.ComponentModel.ReferenceConverter)) return false;
            var asm = conv.GetType().Assembly;
            return ReferenceEquals(asm, typeof(System.ComponentModel.ReferenceConverter).Assembly)
                || ReferenceEquals(asm, typeof(Control).Assembly);
        }

        /// <summary>Reset one property on a live control to its default via its PropertyDescriptor (mirror of
        /// <see cref="TryApply"/>). CanResetValue==true → ResetValue makes the picture match. CanResetValue==false
        /// splits: a property that no longer ShouldSerialize is already at its default (benign success); a property
        /// that STILL serializes has no design-time default the compiled instance can compute (Location/Size/many
        /// vendor props) — ResetValue is a no-op that would leave the built value in the picture, so we report a
        /// reason (→ Applied=false → host surfaces "renders fully after a rebuild") rather than silently lying.</summary>
        private bool TryReset(LiveDesign live, string componentId, string propName, out string reason)
        {
            reason = "";
            // Same restricted resolution as TryApply (control via ByField, else a field-backed ToolStripItem via the
            // reverse-scan; never a non-item component — see ResolveLiveEditTarget) so the two mirrors never diverge.
            // The host currently disables per-property Reset for a ToolStrip item (no ownerId thread), so the item
            // branch is defensive; if it is ever wired, reset works.
            IComponent? target = ResolveLiveEditTarget(live, componentId);
            if (target == null) { reason = "no control '" + componentId + "'"; return false; }
            var pd = TypeDescriptor.GetProperties(target)[propName];
            if (pd == null) { reason = "no property '" + propName + "'"; return false; }
            if (pd.IsReadOnly) { reason = propName + " is read-only"; return false; }
            try
            {
                if (pd.CanResetValue(target))
                {
                    pd.ResetValue(target);
                    RelayoutTarget(target);
                    return true;
                }
                // No reset metadata: ResetValue is a no-op. If the value still serializes it differs from the type
                // default and the compiled instance keeps showing the removed assignment → tell the host so it can
                // note "renders fully after a rebuild". An already-default property is a benign no-op (return true).
                bool stillSet;
                try { stillSet = pd.ShouldSerializeValue(target); } catch { stillSet = false; }
                RelayoutTarget(target);
                if (stillSet) { reason = propName + " has no design-time default on the compiled instance — preview shows the built value until rebuild"; return false; }
                return true;
            }
            catch (Exception ex)
            {
                reason = "could not reset " + propName + ": " + ex.Message;
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

        /// <summary>0.11.0 net48 undo reconcile — drop the cached live instance for (assembly, type) so the NEXT render
        /// re-instantiates from the compiled baseline. The host calls this after an undo/redo/revert reverts the
        /// .Designer.cs text: the cached instance still carries the live mutations of the now-reverted edit (net48
        /// renders the compiled INSTANCE, not the text), so reusing it would keep showing the undone change. Disposing
        /// the form releases its GDI/window handles. Returns true if an entry was actually dropped.</summary>
        public bool DiscardLive(string assemblyPath, string rootTypeName)
        {
            string key;
            try { key = Path.GetFullPath(assemblyPath) + "|" + rootTypeName; } catch { return false; }
            if (!_cache.TryGetValue(key, out var live)) return false;
            _cache.Remove(key);
            try { live.Form?.Dispose(); } catch { /* best effort — the entry is already dropped */ }
            return true;
        }

        /// <summary>
        /// Construct the user's root control the way THEIR OWN code would write `new TheControl()`.
        ///
        /// Activator.CreateInstance(type) only ever finds a PUBLIC, genuinely zero-argument constructor, so it refused
        /// two shapes that are perfectly constructible in C#:
        /// internal TheControl() -> non-public; `new TheControl()` compiles inside its own
        /// assembly, and reflection may call it just as well
        /// internal TheControl(IWavelet wavelet = null) -> every parameter OPTIONAL; `new TheControl()` compiles
        /// and the C# compiler simply passes the author's default,
        /// but in IL the ctor still takes an argument, so a
        /// zero-arg lookup misses it entirely
        /// Both previously died as "No parameterless constructor defined for this object" on a control the project
        /// itself constructs with no arguments.
        ///
        /// We never invent an argument: an optional parameter is filled with the DEFAULT THE AUTHOR DECLARED, which is
        /// exactly what the compiler would pass. A constructor with a REQUIRED parameter is still refused — guessing a
        /// value there would run their code against something they never chose. Fewest parameters wins, so a real
        /// zero-arg ctor is always preferred over an all-optional one.
        /// </summary>
        private static object CreateRoot(Type type)
        {
            var ctors = type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                            .OrderBy(c => c.GetParameters().Length)
                            .ToList();
            foreach (var c in ctors)
            {
                var ps = c.GetParameters();
                if (ps.Length > 0 && !ps.All(p => p.IsOptional)) continue; // needs a real argument → not ours to guess
                object[] args = ps.Select(DefaultArgFor).ToArray();
                return c.Invoke(args); // a ctor throw surfaces via the caller's unwrap
            }
            // Nothing callable with no arguments: say so with the signatures we DID find, so the message is actionable
            // instead of the framework's bare "No parameterless constructor defined for this object."
            string sigs = ctors.Count == 0
                ? "it declares no constructors"
                : "its constructors are: " + string.Join(" | ", ctors.Select(Signature).ToArray());
            throw new MissingMethodException(
                type.FullName + " cannot be constructed with no arguments — " + sigs +
                ". The compiled preview builds the real control, so it needs a constructor callable with no arguments" +
                " (a parameterless one, or one whose parameters are all optional).");
        }

        private static object? DefaultArgFor(ParameterInfo p)
        {
            if (p.HasDefaultValue) return p.DefaultValue; // the author's own default
            return p.ParameterType.IsValueType ? Activator.CreateInstance(p.ParameterType) : null;
        }

        private static string Signature(ConstructorInfo c)
        {
            string vis = c.IsPublic ? "public" : c.IsAssembly ? "internal" : c.IsFamily ? "protected" : "private";
            return vis + " .ctor(" + string.Join(", ", c.GetParameters()
                .Select(p => p.ParameterType.Name + (p.IsOptional ? " = default" : "")).ToArray()) + ")";
        }

        /// <summary>Flatten an exception chain into one honest line for the host, dropping reflection's contentless
        /// wrapper. TargetInvocationException's own message ("Exception has been thrown by the target of an
        /// invocation.") names nothing; the chain underneath is the answer. Keeps the intermediate links too — e.g. a
        /// TypeInitializationException says WHICH type's initializer failed, which GetBaseException() alone loses —
        /// and stops at 4 so one runaway chain can't flood the status line.</summary>
        private static string DescribeFailure(Exception ex)
        {
            var sb = new StringBuilder();
            int shown = 0;
            for (Exception? c = ex; c != null && shown < 4; c = c.InnerException)
            {
                if (c is TargetInvocationException && c.InnerException != null) continue; // wrapper, no information
                if (sb.Length > 0) sb.Append(" <- ");
                sb.Append(c.GetType().Name).Append(": ").Append(c.Message);
                shown++;
            }
            return sb.Length > 0 ? sb.ToString() : ex.GetType().Name + ": " + ex.Message;
        }

        private LiveDesign Build(string assemblyPath, string rootTypeName, int reqWidth, int reqHeight)
        {
            var diag = new StringBuilder();
            Assembly asm = Assembly.LoadFrom(Path.GetFullPath(assemblyPath));
            Type type = ResolveType(asm, rootTypeName, diag);

            object instance;
            try { instance = CreateRoot(type); }
            catch (Exception ex)
            {
                // Reflection wraps whatever the control's ctor threw in a TargetInvocationException whose OWN message is
                // the contentless "Exception has been thrown by the target of an invocation." — which is exactly what
                // reached the user as "designer render failed", telling them nothing. A ctor that needs runtime
                // services/DI, a license check, or a missing dependency is the single most common reason a compiled
                // control can't be previewed, so the refusal has to name the real cause to be honest rather than merely
                // safe. (The add-control / collection paths already unwrap this way; the ROOT instantiation — the one
                // that matters most — did not.)
                throw new InvalidOperationException(
                    rootTypeName + " could not be constructed — " + DescribeFailure(ex), ex);
            }
            if (!(instance is Control rootCtl))
            {
                throw new InvalidOperationException(rootTypeName + " is not a System.Windows.Forms.Control");
            }

            var fieldNames = BuildFieldNameMap(instance, type);

            Form form;
            if (rootCtl is Form rootForm)
            {
                // The root type is ITSELF a top-level window (a Form / DevExpress XtraForm, e.g. WellTieForm).
                // A Form cannot be added as a child of another control — WinForms throws "Top-level control
                // cannot be added to a control". So host it DIRECTLY: realize it off-screen and snapshot the
                // whole window. This mirrors the net9 engine, whose RootComponent for a form-based .Designer.cs
                // IS the Form itself (it draws root.DrawToBitmap on the form), and ComputeWindowOffset already
                // accounts for a form's chrome (window-vs-client size), so child rects line up either way.
                rootForm.StartPosition = FormStartPosition.Manual;
                rootForm.ShowInTaskbar = false;
                rootForm.Location = new Point(-20000, -20000); // off-screen, no visible flash
                if (reqWidth > 0 && reqHeight > 0) rootForm.ClientSize = new Size(reqWidth, reqHeight);
                form = rootForm;
                form.Show(); // realizes the whole control tree's handles, off-screen
            }
            else
            {
                // A UserControl / plain Control root: wrap it in an off-screen borderless host form so its
                // handle tree (and any DevExpress skinning) realizes exactly as at runtime (spike S5).
                form = new Form
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
            }

            for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
            rootCtl.PerformLayout();
            Application.DoEvents();

            var byField = new Dictionary<string, Control>(StringComparer.Ordinal);
            foreach (var kv in fieldNames)
            {
                if (kv.Key is Control ctl && !byField.ContainsKey(kv.Value)) byField[kv.Value] = ctl;
            }

            return new LiveDesign { Form = form, Root = rootCtl, Type = type, FieldNames = fieldNames, ByField = byField, BuildId = ComputeBuildId(assemblyPath) };
        }

        /// <summary>Capture <paramref name="root"/> to a PNG at an integer DPI scale. scale &gt; 1 scales the control tree
        /// UP so text/metrics draw at the higher resolution (crisp) — a bigger DrawToBitmap alone would only upscale.
        /// Scale mutates the tree, so it is restored in finally; an integer factor keeps up/down scaling exactly
        /// reversible, which matters for the CACHED compiled instance (the interpreted tree is fresh each render).</summary>
        private static byte[] CaptureScaledPng(Control root, int w, int h, int scale)
        {
            if (scale > 1)
            {
                root.Scale(new SizeF(scale, scale));
                try
                {
                    using (var big = new Bitmap(w * scale, h * scale, PixelFormat.Format32bppArgb))
                    {
                        big.SetResolution(96, 96);
                        root.DrawToBitmap(big, new Rectangle(0, 0, w * scale, h * scale));
                        using (var ms = new MemoryStream()) { big.Save(ms, ImageFormat.Png); return ms.ToArray(); }
                    }
                }
                finally { root.Scale(new SizeF(1f / scale, 1f / scale)); }
            }
            using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb))
            {
                root.DrawToBitmap(bmp, new Rectangle(0, 0, w, h));
                using (var ms = new MemoryStream()) { bmp.Save(ms, ImageFormat.Png); return ms.ToArray(); }
            }
        }

        private RenderLayoutResult Snapshot(LiveDesign live)
        {
            Control root = live.Root;
            int w = Math.Max(root.Width, 1), h = Math.Max(root.Height, 1);
            byte[] png = CaptureScaledPng(root, w, h, _renderScale);

            string rootClassName = live.DesignedTypeName != null ? InterpretedDescribeResolver.ShortName(live.DesignedTypeName) : live.Type.Name;
            var controls = BuildLayoutControls(root, rootClassName, live.FieldNames, w, h);
            var tray = BuildTray(live);
            var toolStripItems = BuildToolStripItemGeometry(live);

            return new RenderLayoutResult
            {
                RenderMode = live.Mode,
                FallbackReason = live.FallbackReason,
                // 1.0.0 fail-closed — stamp EVERY response with the identity of the instance it was drawn from.
                // Snapshot is the single construction site for RenderLayoutResult, so no net48 response can reach the
                // host without it, and the host never has to guess whether the instance it is looking at is the one
                // its unsaved edits were mirrored onto.
                LiveInstanceId = live.InstanceId,
                LiveBuildId = live.BuildId,
                Png = png,
                Width = w,
                Height = h,
                ClientWidth = root.ClientSize.Width,
                ClientHeight = root.ClientSize.Height,
                RootType = live.DesignedTypeName ?? live.Type.FullName ?? live.Type.Name,
                TotalStatements = controls.Count,
                Representable = controls.Count, // compiled render: no interpreted-subset gaps
                Controls = controls,
                Tray = tray,
                ToolStripItems = toolStripItems,
            };
        }

        private ComponentDesc? DescribeOn(LiveDesign live, string componentId)
        {
            bool isRoot = componentId == "this" || componentId.Length == 0;
            // Controls resolve via ByField, a field-backed non-Control component (a ToolStripItem) via the FieldNames
            // reverse-scan — see ResolveLiveTarget, the single resolver describe / edit / reset all share so they can
            // never disagree about what an id points at.
            IComponent? target = ResolveLiveTarget(live, componentId);
            if (target == null) return null;
            // Parity with net9 DesignerDescribe.ParentName: only a Control parented under another Control carries a
            // Parent; a non-Control Component (e.g. a ToolStripItem) reports none.
            string? parent = isRoot ? null : (target is Control tc ? NearestFieldBackedParent(tc, live) : null);
            string name = isRoot ? live.Type.Name : componentId;
            // Component-reference dropdown candidates (AcceptButton/CancelButton/ContextMenuStrip…): every field-backed
            // component and its field name, from the FieldNames map. The compiled instance is NOT sited, so its
            // ReferenceConverter can't list siblings and Site.Name is null — CompiledDescriber self-enumerates these
            // pairs instead (engine-symmetric with net9's host.Container.Components / Site.Name). Root has no field
            // entry, so it is naturally excluded (never a `this.<field>` reference target).
            // Build candidates from the fields DECLARED on the root form class ITSELF, read off the live instance —
            // NOT from the reflection FieldNames map (which BuildFieldNameMap fills by ALSO walking BASE types, for
            // render/hit-test). An inherited base-class field is not a `this.<field>` the derived .Designer.cs can spell
            // to the right instance: a private base field won't compile, and — critically — a `new`-HIDDEN base field
            // sharing a derived field's name would, under a name-only filter, let the BASE instance masquerade under the
            // derived name and rewrite the reference to the WRONG component on a pick. Reading each DeclaredOnly field's
            // VALUE off live.Root (== the user's form/UC instance, whose runtime type IS live.Type; live.Form may be a
            // wrapper) binds name→the EXACT instance that field holds, so a live reference to a base/hidden instance
            // simply has no candidate and stays a plain field (fail-closed). net9's interpreter never sees base
            // components either, so this keeps offer⇔accept AND cross-runtime parity.
            var siblings = new List<KeyValuePair<string, IComponent>>();
            var seenSib = new HashSet<object>(ReferenceEqualityComparer.Instance);
            foreach (var f in live.Type.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
            {
                if (f.Name.Length == 0 || !typeof(IComponent).IsAssignableFrom(f.FieldType)) continue;
                object? val;
                try { val = f.GetValue(live.Root); } catch { continue; }
                if (val is IComponent comp && !ReferenceEquals(comp, live.Root) && seenSib.Add(comp))
                    siblings.Add(new KeyValuePair<string, IComponent>(f.Name, comp));
            }
            return CompiledDescriber.Describe(target, isRoot ? "this" : componentId, name, isRoot, parent, siblings, live.Root);
        }

        /// <summary>Reverse the component→field-name map to find the live component a designer field id names — the
        /// path DescribeOn takes for a non-Control field (a ToolStripItem). Reads FieldNames directly (kept pruned by
        /// every remove path + populated by every live-add path) so there is no parallel map to fall out of sync; the
        /// scan is O(field count) and only runs on the ByField miss (never for a plain control). Field names are
        /// unique, so at most one entry matches.</summary>
        private static IComponent? ResolveComponentByFieldName(LiveDesign live, string fieldName)
        {
            foreach (var kv in live.FieldNames)
                if (kv.Value == fieldName && kv.Key is IComponent comp) return comp;
            return null;
        }

        /// <summary>Resolve a component id to its live instance for a per-property live edit / reset / describe: a
        /// control via ByField (the fast path), else a field-backed non-Control IComponent (a ToolStripItem) via the
        /// FieldNames reverse-scan. Root ("this"/"") → the form. Null when the id names nothing live. One resolver so
        /// describe and edit can never disagree about what an id points at.</summary>
        private IComponent? ResolveLiveTarget(LiveDesign live, string componentId)
        {
            if (componentId == "this" || componentId.Length == 0) return live.Root;
            return live.ByField.TryGetValue(componentId, out var c) ? c : ResolveComponentByFieldName(live, componentId);
        }

        /// <summary>Resolve a component id for a live property EDIT / RESET — like <see cref="ResolveLiveTarget"/> (the
        /// describe resolver) but RESTRICTED to a Control or a ToolStripItem. A field-backed non-Control non-item
        /// component (a Timer / BackgroundWorker / ToolTip / ImageList) is describable yet must NOT be
        /// live-mutated: this is a real running preview instance, so e.g. Timer.Enabled=true would Start() it and the
        /// render pump (Application.DoEvents) would dispatch the compiled Tick handler INSIDE the preview — a design
        /// surface must never run a component's runtime behavior. Such an id returns null here → the live edit is an
        /// inert no-op (Applied=false; the source edit still persists via the net9 splice, and VS likewise only
        /// serializes the value, it does not run the component). This precisely restores the earlier behavior for
        /// every non-item component (only a ToolStripItem is newly live-editable). Null for an unknown id too.</summary>
        private IComponent? ResolveLiveEditTarget(LiveDesign live, string componentId)
        {
            var target = ResolveLiveTarget(live, componentId);
            return target is Control || target is ToolStripItem ? target : null;
        }

        /// <summary>Force the layout that reflects a just-applied property edit: a Control re-lays-out itself; a
        /// ToolStripItem owns no layout, so its owning strip re-measures (setting e.g. Text already invalidates it —
        /// this makes the new size immediate). The caller additionally PerformLayouts the root form.</summary>
        private static void RelayoutTarget(IComponent target)
        {
            if (target is Control ctl) ctl.PerformLayout();
            else if (target is ToolStripItem item) item.Owner?.PerformLayout();
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

        /// <summary>
        /// The compiled form type, by EXACT name only.
        ///
        /// There used to be a fallback: if the exact lookup missed, take the unique Control in the assembly with the
        /// same SHORT name. That is a guess, and it rendered a different form as yours with no banner — the
        /// "resolved root by simple name" note it left went into a StringBuilder nobody reads. It also
        /// papered over the real bug: this host built the type name itself and got it wrong for a form nested in a
        /// record/struct, or a generic one. The name now comes from the shared FormClassResolver identity, which is
        /// already reflection's format, and in C# a type's source-declared full name IS its runtime name (unlike VB,
        /// RootNamespace does not rewrite it) — so an exact miss means the assembly genuinely lacks this type: a
        /// stale build, not something to guess around. Say so.
        /// </summary>
        private static Type ResolveType(Assembly asm, string rootTypeName, StringBuilder diag)
        {
            Type t = asm.GetType(rootTypeName, throwOnError: false);
            if (t != null) return t;
            throw new InvalidOperationException(
                "root type not found in assembly: " + rootTypeName + " (is the project built and up to date?)");
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
                // A field-backed control on a NON-active tab page (or otherwise hidden) is not on the visible surface.
                // Its rect is stacked under the active page, so including it lets it STEAL a hit-test from the control
                // the user actually clicked (e.g. a control on a hidden tab intercepting a click on a footer panel).
                if (!isRoot && !IsOnVisibleSurface(ctrl, root)) continue;

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
                    IsTabHost = LooksLikeTabHost(ctrl),
                    IsStripHost = ctrl is ToolStrip && (isRoot || ctrl.Parent != null), // lockstep with item-geometry emission
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

        /// <summary>Width (horizontal strip) / height (vertical strip) of the synthesized trailing "Type Here" slot.
        /// Mirrors the net9 engine's TypeHereExtent so the cross-runtime overlay is placed identically.</summary>
        private const int TypeHereExtent = 66;

        /// <summary>Per-item window-space geometry for every TOP-LEVEL ToolStrip/MenuStrip/StatusStrip item on the live
        /// compiled instance, plus a synthesized trailing "Type Here" slot per strip — the net48 analogue of the net9
        /// <c>BuildToolStripItems</c>. Items are Components (not Controls) so they never appear in BuildLayoutControls;
        /// their id is the field-map name (<see cref="ToolStripItemId"/>). item.Bounds is valid because Build() has
        /// already shown the form off-screen + pumped + laid out; only top-level items (a closed submenu isn't laid
        /// out). Overflowed / unavailable items are skipped.</summary>
        private static List<ToolStripItemBounds> BuildToolStripItemGeometry(LiveDesign live)
        {
            var items = new List<ToolStripItemBounds>();
            Control root = live.Root;
            var all = new List<Control>();
            Collect(root, all);
            foreach (var ctrl in all)
            {
                if (!(ctrl is ToolStrip strip)) continue;
                if (!ReferenceEquals(strip, root) && !IsOnVisibleSurface(strip, root)) continue;
                string ownerId = ReferenceEquals(strip, root) ? "this" : IdOf(strip, live.FieldNames);
                if (ownerId.Length == 0) continue;

                try { strip.PerformLayout(); } catch { /* layout hiccup → bounds may be default */ }
                var (ox, oy) = ComputeWindowOffset(strip, root);
                var disp = strip.DisplayRectangle; // the item-row area, in strip coords
                bool horizontal = strip.Orientation == Orientation.Horizontal;
                int contentEnd = horizontal ? disp.Left : disp.Top; // running right/bottom edge of the last item
                var overflowItems = new List<ToolStripItemBounds>(); // items pushed off the main strip (Placement==Overflow)

                foreach (ToolStripItem it in strip.Items)
                {
                    if (!it.Available) continue;
                    // An OVERFLOW-placed item isn't on the main strip → harvest it BOUNDS-LESS and surface it via the
                    // chevron flyout below (mirrors net9).
                    if (it.Placement == ToolStripItemPlacement.Overflow)
                    {
                        overflowItems.Add(new ToolStripItemBounds
                        {
                            OwnerId = ownerId,
                            ItemId = ToolStripItemId(it, live),
                            ItemType = it.GetType().FullName ?? it.GetType().Name,
                            Text = it.Text ?? "",
                            IsTypeHere = false,
                            Children = BuildItemChildren(it, ownerId, live),
                        });
                        continue;
                    }
                    if (it.Placement != ToolStripItemPlacement.Main) continue; // Placement.None → not shown anywhere
                    var b = it.Bounds;
                    items.Add(new ToolStripItemBounds
                    {
                        OwnerId = ownerId,
                        ItemId = ToolStripItemId(it, live),
                        ItemType = it.GetType().FullName ?? it.GetType().Name,
                        Text = it.Text ?? "", // live caption → canvas prefills the rename editor
                        X = ox + b.X,
                        Y = oy + b.Y,
                        Width = Math.Max(b.Width, 1),
                        Height = Math.Max(b.Height, 1),
                        IsTypeHere = false,
                        Children = BuildItemChildren(it, ownerId, live), // nested submenu → canvas synthetic flyout
                    });
                    contentEnd = Math.Max(contentEnd, horizontal ? b.Right : b.Bottom);
                }

                // The overflow chevron: a bounds-carrying, id-less item whose Children are the overflow items (mirrors net9).
                var ob = strip.OverflowButton;
                bool overflowing = overflowItems.Count > 0 && ob != null;
                if (overflowing)
                {
                    var obb = ob.Bounds; // strip-relative, like item.Bounds
                    items.Add(new ToolStripItemBounds
                    {
                        OwnerId = ownerId,
                        ItemType = ob.GetType().FullName ?? ob.GetType().Name,
                        X = ox + obb.X,
                        Y = oy + obb.Y,
                        Width = Math.Max(obb.Width, 1),
                        Height = Math.Max(obb.Height, 1),
                        IsTypeHere = false,
                        Overflow = true,
                        Children = overflowItems,
                    });
                }

                // Cross-axis placement from DisplayRectangle (stable item-row band), NOT the last item — mirrors net9.
                // Suppressed when the strip is overflowing (it's full — mirrors net9).
                if (!overflowing)
                {
                    items.Add(horizontal
                        ? new ToolStripItemBounds { OwnerId = ownerId, IsTypeHere = true, X = ox + contentEnd + 2, Y = oy + disp.Top, Width = TypeHereExtent, Height = Math.Max(disp.Height, 1) }
                        : new ToolStripItemBounds { OwnerId = ownerId, IsTypeHere = true, X = ox + disp.Left, Y = oy + contentEnd + 2, Width = Math.Max(disp.Width, 1), Height = TypeHereExtent });
                }
            }
            return items;
        }

        /// <summary>Recursively collect a drop-down item's nested DropDownItems as BOUNDS-LESS ToolStripItemBounds
        /// (id via <see cref="ToolStripItemId"/> / text / type + their own Children) for the canvas synthetic submenu
        /// flyout — the net48 analogue of the net9 <c>BuildItemChildren</c>. A closed dropdown isn't laid out, so children
        /// have no bounds; the canvas draws the flyout and routes a child click through the item→Properties channel
        /// (net48 resolves a nested field-backed item via the FieldNames reverse-scan). Gated on HasDropDownItems so a
        /// closed dropdown is never created. Depth is bounded by the live menu tree.</summary>
        private static List<ToolStripItemBounds> BuildItemChildren(ToolStripItem item, string ownerId, LiveDesign live)
        {
            var kids = new List<ToolStripItemBounds>();
            if (item is ToolStripDropDownItem ddi && ddi.HasDropDownItems)
            {
                foreach (ToolStripItem child in ddi.DropDownItems)
                {
                    kids.Add(new ToolStripItemBounds
                    {
                        OwnerId = ownerId,
                        ItemId = ToolStripItemId(child, live),
                        ItemType = child.GetType().FullName ?? child.GetType().Name,
                        Text = child.Text ?? "",
                        IsTypeHere = false,
                        Children = BuildItemChildren(child, ownerId, live),
                    });
                }
            }
            return kids;
        }

        private static void Collect(Control c, List<Control> acc)
        {
            acc.Add(c);
            foreach (Control child in c.Controls) Collect(child, acc);
        }

        /// <summary>True when the control is on the CURRENTLY-SHOWN surface. Two signals: (1) Control.Visible, which
        /// cascades through parents — catches an explicitly-hidden control and a standard WinForms TabControl's
        /// inactive pages; (2) a reflective active-tab check for tab libraries (DevExpress XtraTabControl) that keep
        /// non-active pages Visible=true and only paint the selected one. The reflective check hides the control ONLY
        /// when an ancestor is positively identified as a tab host (has a TabPages collection + a SelectedTab/Page)
        /// and the ancestor chain runs through a page that is NOT the selected one. Any reflection failure or
        /// ambiguity defaults to VISIBLE — we never hide a control we are unsure about.</summary>
        private static bool IsOnVisibleSurface(Control ctrl, Control root)
        {
            if (!ctrl.Visible) return false;
            try
            {
                for (Control? c = ctrl; c != null && !ReferenceEquals(c, root); c = c.Parent)
                {
                    var parent = c.Parent;
                    if (parent == null) break;
                    var pagesProp = FindTabProp(parent.GetType(), "TabPages");
                    var selProp = FindTabProp(parent.GetType(), "SelectedTab", "SelectedTabPage", "SelectedPage");
                    if (pagesProp == null || selProp == null) continue;
                    if (pagesProp.GetValue(parent) is not System.Collections.IEnumerable pages) continue;
                    bool cIsPage = false;
                    foreach (var pg in pages) if (ReferenceEquals(pg, c)) { cIsPage = true; break; }
                    if (!cIsPage) continue; // c is an internal part, not one of the pages
                    var active = selProp.GetValue(parent) as Control;
                    if (active != null && !ReferenceEquals(active, c)) return false; // c is a non-selected page
                }
            }
            catch { /* reflection hiccup → treat as visible (never over-hide) */ }
            return true;
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
                if (!(kv.Key is IComponent)) continue;
                // A PARENTED Control lives in the visual layout (BuildLayoutControls), never the tray. But an OFF-TREE
                // Control (Parent==null, not the root) is a sited field never added to any Controls collection — a
                // ContextMenuStrip / ToolStripDropDown — so Collect(root) never reaches it and it isn't in the visual
                // tree. It belongs in the tray, exactly as Visual Studio shows a ContextMenuStrip. Mirrors the net9
                // engine's BuildLayoutControls/BuildTray split (both skip the phantom control rect, both tray it).
                if (kv.Key is Control ctrl && (ReferenceEquals(ctrl, live.Root) || ctrl.Parent != null)) continue;
                // A field-backed strip item is in FieldNames (that's how geometry/describe resolve it), but Visual Studio
                // never trays strip items — they are edited on the strip itself (on-canvas Type Here / the item editor).
                // The tray holds only non-visual components (Timer/ToolTip/…) + off-tree Controls (ContextMenuStrip).
                if (kv.Key is ToolStripItem) continue;
                if (!seen.Add(kv.Key)) continue;
                tray.Add(new TrayComponent
                {
                    Id = kv.Value,
                    Name = kv.Value,
                    Type = kv.Key.GetType().FullName ?? kv.Key.GetType().Name,
                    // An OFF-TREE ToolStrip (a ContextMenuStrip) carries its top-level Items so the canvas opens a
                    // synthetic flyout from its tray chip; a non-strip component leaves this empty.
                    Items = kv.Key is ToolStrip strip ? BuildStripItemForest(strip, kv.Value, live) : new List<ToolStripItemBounds>(),
                    IsStrip = kv.Key is ToolStrip, // an EMPTY off-tree strip still opens an add-first-item flyout (Items alone can't distinguish it from a non-strip)
                });
            }
            return tray;
        }

        /// <summary>The top-level Items of an OFF-TREE ToolStrip (a tray ContextMenuStrip) as a BOUNDS-LESS forest — the
        /// net48 analogue of the net9 <c>BuildStripItemForest</c>. No bounds (the strip is never on the surface); ids via
        /// the <see cref="ToolStripItemId"/> FieldNames map so add/rename/delete/describe resolve. Pure reads
        /// (HasDropDownItems-gated recursion never creates a closed dropdown). ownerId (the strip's id) is the host
        /// splice key.</summary>
        private static List<ToolStripItemBounds> BuildStripItemForest(ToolStrip strip, string ownerId, LiveDesign live)
        {
            var forest = new List<ToolStripItemBounds>();
            foreach (ToolStripItem it in strip.Items)
            {
                forest.Add(new ToolStripItemBounds
                {
                    OwnerId = ownerId,
                    ItemId = ToolStripItemId(it, live),
                    ItemType = it.GetType().FullName ?? it.GetType().Name,
                    Text = it.Text ?? "",
                    IsTypeHere = false,
                    Children = BuildItemChildren(it, ownerId, live),
                });
            }
            return forest;
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
