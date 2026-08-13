using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Xml;

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
            public HashSet<string> AmbiguousIds = default!;
            /// <summary>Per-instance visual-inheritance ownership. Every editable route consults this map; a missing
            /// entry is <see cref="InheritedOwnershipPolicy.Unresolved"/> and therefore fails closed.</summary>
            public Dictionary<object, string> Ownership = default!;
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
            /// <summary>1.2.x INTERPRETED REUSE — the exact source buffer (+ tab overrides) this graph was built from,
            /// as an opaque key from the host side. An interpreted graph may only be re-snapshotted while the engine
            /// can PROVE it still corresponds to the caller's buffer, so the key is compared on every render and
            /// re-stamped only by an edit the engine itself applied to this instance. Any mismatch rebuilds.
            /// "" on the compiled path, which is keyed by build identity instead.</summary>
            public string SourceKey = "";
            /// <summary>Just the buffer half of <see cref="SourceKey"/> — describe needs to know the graph is this
            /// TEXT, but is indifferent to which tab is shown or at what capture scale the picture was taken.</summary>
            public string BufferKey = "";
            /// <summary>The interpreter plan (identity model) this graph was built from, so a describe can read the
            /// same instances the picture was drawn from instead of building a throwaway graph of its own.</summary>
            public InterpretedRenderPlan? Plan = null;
            /// <summary>Set the moment a live edit mutates this graph. A mutated graph is a PICTURE, not an
            /// interpretation: setting a property on a finished graph is not the same as replaying the edited source
            /// (lowering NumericUpDown.Maximum clamps an existing Value, where a replay would hit the unchanged
            /// Value statement and fail closed), and a pumped message can move it further still. So it may be shown
            /// for the edit that produced it and never reused to answer a later render or describe.</summary>
            public bool Mutated = false;
            /// <summary>Which buffer the LAST PICTURE handed to the host claims to represent. Equals SourceKey for a
            /// freshly interpreted graph and advances with each live edit, so a following edit can prove it started
            /// from the picture actually on screen.</summary>
            public string PictureKey = "";
            /// <summary>The size this graph was hosted at (0 = the form's own). Part of the compiled entry's identity:
            /// a graph built for one requested size is not a picture of another.</summary>
            public int ReqWidth = 0;
            public int ReqHeight = 0;
            /// <summary>Capture scale this graph belongs to. Kept per-graph because the worker serves several forms: a
            /// live-op Snapshot that does not restate the scale must use the one ITS graph was rendered at, not
            /// whatever another form set last.</summary>
            public int Scale = 0; // 0 = not stated for this graph → fall back to the worker-wide value
            /// <summary>When this graph was interpreted (UTC ticks). Reuse is TIME-BOUNDED: a cached graph is not
            /// frozen — any RPC that pumps the STA also dispatches ITS pending messages, so a vendor control with an
            /// animation or blink timer advances where a fresh replay would not. Seconds-old reuse is still the same
            /// picture (and that is the whole working window: a drag burst, a re-render of the same buffer); a
            /// minutes-old graph is rebuilt rather than trusted.</summary>
            public long BuiltAtUtcTicks = 0;
            /// <summary>The design-time container owning this graph's sited components (interpreted path only).
            /// Cached alongside the form so eviction disposes both, in reverse order.</summary>
            public IDisposable? Container = null;
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
        private readonly Dictionary<string, string> _designerCultures = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
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

        /// <summary>Set the selected UI culture for one designer file. Empty/null means the neutral .resx only.
        /// Non-empty values are validated through <see cref="CultureInfo.GetCultureInfo(string)"/> and stored in the
        /// framework-normalized form (for example, "fr-fr" becomes "fr-FR").</summary>
        public string SetDesignerCulture(string designerFilePath, string cultureName)
        {
            return _sta.Invoke(() =>
            {
                string designerKey = NormalizeDesignerPath(designerFilePath);
                string culture = NormalizeDesignerCulture(cultureName);
                if (culture.Length == 0) _designerCultures.Remove(designerKey);
                else _designerCultures[designerKey] = culture;
                return culture;
            });
        }

        /// <summary>Read the selected UI culture for one designer file. Empty means neutral.</summary>
        public string GetDesignerCulture(string designerFilePath)
        {
            return _sta.Invoke(() => SelectedCultureForDesigner(designerFilePath));
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
            return _sta.Invoke(() => { _renderScale = renderScale; return Snapshot(GetOrCreate(assemblyPath, rootTypeName, reqWidth, reqHeight)); });
        }

        /// <summary>Render the LIVE .Designer.cs source via the IR interpreter (VS model: instantiate
        /// the immediate BASE type, replay the parsed statements onto it against the project's COMPILED control
        /// types), or FALL BACK to the compiled last build with a named reason when the interpreter can't fully cover
        /// the form. Always returns a picture; RenderMode ("interpreted" | "compiledFallback") + FallbackReason tell
        /// the host which it got. NOT cached — it reflects the exact source buffer on every call (the whole point).</summary>
        public RenderLayoutResult RenderInterpretedWithLayout(string designerFilePath, string assemblyPath, IrDocument? doc,
            string rootTypeName, int reqWidth, int reqHeight, string[]? selectedTabs = null, int renderScale = 1,
            string sourceKey = "")
        {
            return _sta.Invoke(() =>
            {
                _renderScale = renderScale;
                string cultureName = SelectedCultureForDesigner(designerFilePath);
                // 1.2.x INTERPRETED REUSE. Rebuilding the whole graph — construct every vendor control, replay the IR,
                // host it off-screen, pump, lay out — costs ~400 ms on a real DevExpress form, while snapshotting a
                // graph that is already live costs ~12 ms. So a render whose buffer the cached graph provably matches
                // re-snapshots instead of rebuilding. The proof is exact and conservative: same source key (buffer +
                // tab overrides + capture scale), same build identity, or it rebuilds.
                string reuseKey = InterpretedKey(designerFilePath, assemblyPath, rootTypeName);
                if (!string.IsNullOrEmpty(sourceKey) && _cache.TryGetValue(reuseKey, out var cached))
                {
                    // Reuse demands three proofs: the graph is a pure INTERPRETATION (never live-mutated), it was
                    // built from this exact identity (buffer + sibling .resx + tab overrides + capture scale +
                    // requested size), and the build under it has not moved. Anything else rebuilds.
                    if (!cached.Mutated && IsFresh(cached)
                        && cached.SourceKey == SourceStamp(designerFilePath, cultureName, sourceKey, selectedTabs, renderScale, reqWidth, reqHeight)
                        && cached.BuildId == ComputeBuildId(assemblyPath))
                        return Snapshot(cached);
                    EvictInterpreted(reuseKey); // stale, aged out or mutated — not what the caller is asking for
                }
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
                var host = new AssemblyIrHost(ProbeAssembliesFor(asm), container, LoadSiblingResx(designerFilePath, cultureName), doc?.NamespaceContext);
                Form? builtForm = null;
                InterpretedRenderPlan? plan = null;
                bool keepAlive = false; // set once the graph is cached for reuse — then `finally` must NOT tear it down
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
                    // …and again AFTER the pump: a form can re-stage itself from a posted message (BeginInvoke, Shown,
                    // a vendor layout continuation), which lands here rather than inside Show.
                    ReassertRootWindow(builtForm, reqWidth, reqHeight);
                    rootCtl.PerformLayout();
                    Application.DoEvents();

                    var exec = plan.Execution!;
                    // FieldNames = the interpreter's own name→instance table inverted (the analogue of the reflection map),
                    // which already merges inherited base components + current-source ones (hybrid identity).
                    var fieldNames = new Dictionary<object, string>(ReferenceEqualityComparer.Instance);
                    foreach (var kv in exec.Instances)
                        if (kv.Key.Length != 0 && !fieldNames.ContainsKey(kv.Value)) fieldNames[kv.Value] = kv.Key;
                    var byField = BuildControlIndex(fieldNames, out var ambiguousIds);
                    var ownership = new Dictionary<object, string>(ReferenceEqualityComparer.Instance)
                    {
                        [rootCtl] = InheritedOwnershipPolicy.Root,
                    };
                    foreach (var kv in exec.Instances)
                    {
                        if (ReferenceEquals(kv.Value, rootCtl)) continue;
                        string value = InheritedOwnershipPolicy.Unresolved;
                        if (exec.Origins.TryGetValue(kv.Key, out var origin))
                        {
                            if (origin == IrOrigin.DeclaredInCurrentSource) value = InheritedOwnershipPolicy.CurrentSource;
                            else if (origin == IrOrigin.Inherited) value = InheritedOwnershipPolicy.Inherited;
                            else if (origin == IrOrigin.Root) value = InheritedOwnershipPolicy.Root;
                        }
                        if (!ownership.ContainsKey(kv.Value)) ownership[kv.Value] = value;
                    }

                    var live = new LiveDesign
                    {
                        Form = builtForm,
                        Root = rootCtl,
                        Type = rootCtl.GetType(),
                        FieldNames = fieldNames,
                        ByField = byField,
                        AmbiguousIds = ambiguousIds,
                        Ownership = ownership,
                        BuildId = ComputeBuildId(assemblyPath),
                        Mode = "interpreted",
                        DesignedTypeName = plan.DesignedTypeName,
                        SourceKey = SourceStamp(designerFilePath, cultureName, sourceKey, selectedTabs, renderScale, reqWidth, reqHeight),
                        PictureKey = SourceStamp(designerFilePath, cultureName, sourceKey, selectedTabs, renderScale, reqWidth, reqHeight),
                        BufferKey = BufferStamp(designerFilePath, cultureName, sourceKey),
                        Plan = plan,
                        Container = container,
                        Scale = renderScale,
                        BuiltAtUtcTicks = System.Diagnostics.Stopwatch.GetTimestamp(),
                    };
                    var shot = Snapshot(live);
                    // Keep the graph ONLY when the caller identified its buffer; without a key the next render could
                    // not prove the cache still matches, so the old build-and-throw-away behaviour is kept verbatim.
                    if (!string.IsNullOrEmpty(sourceKey))
                    {
                        TrimInterpretedCache(MaxInterpretedGraphs - 1); // make room, oldest first
                        _cache[reuseKey] = live;
                        keepAlive = true;
                    }
                    return shot;
                }
                catch (BothRenderPathsFailedException)
                {
                    // Already the "neither path worked" report from an inner CompiledFallback — re-wrapping it would
                    // nest the same sentence inside itself and bury the one useful line.
                    throw;
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
                    // A graph that was CACHED for reuse is deliberately left alive; its eviction (EvictInterpreted) owns
                    // the same teardown, so the handles are released exactly once either way.
                    if (!keepAlive)
                    {
                        try { builtForm?.Dispose(); } catch { /* cascades to the realized child-control HWND/GDI tree */ }
                        try { if (builtForm == null && plan?.Root is IDisposable d) d.Dispose(); } catch { /* partly-built root on a late fallback */ }
                        try { container.Dispose(); } catch { /* reverse-order dispose of every sited component */ }
                    }
                }
            });
        }

        /// <summary>Cache key for the INTERPRETED graph of (assembly, designed type). Prefixed so it can never collide
        /// with the compiled entry for the same pair — the two are different pictures of the same form and both may be
        /// live at once (a compiled fallback rendered while an interpreted graph is cached).</summary>
        private static string InterpretedKey(string designerFilePath, string assemblyPath, string rootTypeName)
        {
            string full;
            try { full = Path.GetFullPath(assemblyPath); } catch { full = assemblyPath ?? ""; }
            string file;
            try { file = Path.GetFullPath(designerFilePath ?? ""); } catch { file = designerFilePath ?? ""; }
            // The designer FILE is part of the identity, not just the type: it selects the sibling .resx the graph was
            // built from, and two files can declare the same type name.
            return "interpreted|" + full + "|" + file + "|" + rootTypeName;
        }

        /// <summary>Identity of the sibling .resx as the graph consumed it. The interpreted graph resolves
        /// `resources.GetObject(...)` from that file, so a resource-only change — re-importing an image under the same
        /// key, which the host deliberately commits without touching .Designer.cs — must invalidate the cache even
        /// though the source text is byte-identical.</summary>
        /// <summary>Size cap shared by the resolver and the cache stamp — a sibling .resx is repository-controlled
        /// input, and neither reading it into a DOM nor hashing it may be unbounded.</summary>
        private const long MaxResxBytes = 32L << 20;

        private sealed class ResxCandidate
        {
            public string CultureName = "";
            public string Path = "";
        }

        private static string NormalizeDesignerCulture(string cultureName)
        {
            if (string.IsNullOrWhiteSpace(cultureName)) return "";
            return CultureInfo.GetCultureInfo(cultureName.Trim()).Name;
        }

        private static string NormalizeDesignerPath(string designerFilePath)
        {
            try { return Path.GetFullPath(designerFilePath ?? ""); }
            catch { return designerFilePath ?? ""; }
        }

        private string SelectedCultureForDesigner(string designerFilePath)
        {
            return _designerCultures.TryGetValue(NormalizeDesignerPath(designerFilePath), out var culture)
                ? culture
                : "";
        }

        private static string DesignerResourceBase(string designerFilePath)
        {
            string baseName = designerFilePath ?? "";
            const string designerSuffix = ".Designer.cs";
            if (baseName.EndsWith(designerSuffix, StringComparison.OrdinalIgnoreCase))
                return baseName.Substring(0, baseName.Length - designerSuffix.Length);
            if (baseName.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                return baseName.Substring(0, baseName.Length - ".cs".Length);
            return Path.ChangeExtension(baseName, null) ?? baseName;
        }

        private static List<ResxCandidate> ResxCandidates(string designerFilePath, string cultureName)
        {
            string normalizedCulture = NormalizeDesignerCulture(cultureName);
            string baseName = DesignerResourceBase(designerFilePath);
            var candidates = new List<ResxCandidate>
            {
                new ResxCandidate { CultureName = "", Path = baseName + ".resx" },
            };
            if (normalizedCulture.Length == 0) return candidates;

            var chain = new List<CultureInfo>();
            for (var culture = CultureInfo.GetCultureInfo(normalizedCulture);
                 culture != null && culture.Name.Length != 0;
                 culture = culture.Parent)
            {
                chain.Add(culture);
            }
            chain.Reverse();
            foreach (var culture in chain)
                candidates.Add(new ResxCandidate { CultureName = culture.Name, Path = baseName + "." + culture.Name + ".resx" });
            return candidates;
        }

        private static string ResxIdentity(string resxPath)
        {
            string full;
            try { full = Path.GetFullPath(resxPath ?? ""); } catch { full = resxPath ?? ""; }
            try
            {
                if (!File.Exists(resxPath)) return full + ":missing";
                var fi = new FileInfo(resxPath);
                if (fi.Length > MaxResxBytes) return full + ":overcap";
                using (var sha = System.Security.Cryptography.SHA256.Create())
                    return full + ":sha256:" + Convert.ToBase64String(sha.ComputeHash(File.ReadAllBytes(resxPath)));
            }
            catch { return full + ":unreadable:" + Guid.NewGuid().ToString("N"); }
        }

        private static string? TryReadResxXml(string resxPath)
        {
            try
            {
                if (!File.Exists(resxPath)) return null;
                if (new FileInfo(resxPath).Length > MaxResxBytes) return null;
                return File.ReadAllText(resxPath);
            }
            catch { return null; }
        }

        private static string MergedSiblingResxXml(string designerFilePath, string cultureName)
        {
            var effectiveData = new Dictionary<string, XmlNode>(StringComparer.Ordinal);
            foreach (var candidate in ResxCandidates(designerFilePath, cultureName))
            {
                var xml = TryReadResxXml(candidate.Path);
                if (string.IsNullOrEmpty(xml)) continue;
                var source = new XmlDocument { XmlResolver = null };
                try { source.LoadXml(xml); }
                catch { continue; }
                foreach (XmlNode node in source.GetElementsByTagName("data"))
                {
                    var name = node.Attributes?["name"]?.Value;
                    if (string.IsNullOrEmpty(name)) continue;
                    effectiveData[name!] = node.CloneNode(true);
                }
            }

            if (effectiveData.Count == 0) return "";
            var merged = new XmlDocument { XmlResolver = null };
            var root = merged.CreateElement("root");
            merged.AppendChild(root);
            foreach (var node in effectiveData.Values)
                root.AppendChild(merged.ImportNode(node, true));
            return merged.OuterXml;
        }

        private static string ResxStamp(string designerFilePath, string cultureName)
        {
            var parts = new List<string> { "culture=" + NormalizeDesignerCulture(cultureName) };
            foreach (var candidate in ResxCandidates(designerFilePath, cultureName))
                parts.Add(candidate.CultureName + "=" + ResxIdentity(candidate.Path));
            return string.Join("|", parts.ToArray());
        }

        private static string BufferStamp(string designerFilePath, string cultureName, string sourceKey)
        {
            return sourceKey + "|r" + ResxStamp(designerFilePath, cultureName);
        }

        /// <summary>Everything that changes what an interpreted snapshot LOOKS like, folded into the reuse key: the
        /// caller's buffer identity, the transient selected-tab overrides, and the capture scale. Anything not in here
        /// must not be able to alter the picture, or reuse would show a stale frame.</summary>
        private static string SourceStamp(string designerFilePath, string cultureName, string sourceKey, string[]? selectedTabs,
            int renderScale, int reqWidth, int reqHeight)
            => BufferStamp(designerFilePath, cultureName, sourceKey) + "|s" + renderScale
               + "|d" + reqWidth + "x" + reqHeight
               + "|t" + string.Join(",", selectedTabs ?? Array.Empty<string>());

        /// <summary>How long an interpreted graph may answer for its buffer. `Mutated` proves nobody EDITED it; it
        /// cannot prove the object graph did not advance on its own — a pending vendor timer ticks whenever any other
        /// RPC pumps this STA. Within a few seconds that is the same picture; beyond it, replay from source instead of
        /// asserting an equivalence nothing checked.</summary>
        private static readonly TimeSpan InterpretedGraphMaxAge = TimeSpan.FromSeconds(10);

        /// <summary>Age on a MONOTONIC clock: a wall-clock rollback (an NTP correction, a resumed VM) would otherwise
        /// make an old graph look freshly built for the length of the jump — and would scramble the eviction order.</summary>
        private static bool IsFresh(LiveDesign live)
        {
            long elapsed = System.Diagnostics.Stopwatch.GetTimestamp() - live.BuiltAtUtcTicks;
            return elapsed >= 0 && elapsed <= (long)(InterpretedGraphMaxAge.TotalSeconds * System.Diagnostics.Stopwatch.Frequency);
        }

        /// <summary>How many interpreted graphs may stay alive at once. Each holds a realized off-screen Form, its
        /// whole HWND/GDI tree, the sited components and whatever the vendor controls allocate — so this is a hard
        /// ceiling, not a hint. The host also hands a form's graph back when its designer closes; this bounds the
        /// damage when it cannot (a crash, a session that never closed, a direct RPC caller).</summary>
        private const int MaxInterpretedGraphs = 4;

        /// <summary>Evict the OLDEST interpreted graphs until at most <paramref name="keep"/> remain. Ordered by the
        /// graphs' own build timestamps, not by dictionary enumeration: .NET's Dictionary reuses freed slots, so
        /// enumeration order is not insertion order and "evict the first key" could throw away the graph that was
        /// just built while keeping older ones.</summary>
        private void TrimInterpretedCache(int keep)
        {
            var interpreted = _cache.Where(kv => kv.Key.StartsWith("interpreted|", StringComparison.Ordinal))
                .OrderBy(kv => kv.Value.BuiltAtUtcTicks)
                .Select(kv => kv.Key)
                .ToList();
            for (int i = 0; i + keep < interpreted.Count; i++) EvictInterpreted(interpreted[i]);
        }

        /// <summary>Drop a cached interpreted graph and release its window/GDI handles + sited components.</summary>
        private void EvictInterpreted(string key)
        {
            if (!_cache.TryGetValue(key, out var live)) return;
            _cache.Remove(key);
            try { live.Form?.Dispose(); } catch { /* cascades to the realized child-control HWND/GDI tree */ }
            try { live.Container?.Dispose(); } catch { /* reverse-order dispose of every sited component */ }
        }

        /// <summary>
        /// 1.2.x — apply property edits to the CACHED INTERPRETED graph and re-snapshot, instead of re-interpreting the
        /// whole buffer. This is what makes a drag feel immediate on a vendor form: ~12 ms rather than ~400 ms.
        ///
        /// The result is a PICTURE, not a certified interpretation: setting a property on a finished graph is not the
        /// same operation as replaying the edited source (lowering NumericUpDown.Maximum clamps an existing Value,
        /// where a replay would reach the unchanged Value statement and fail closed). So the graph is marked Mutated,
        /// which permanently bars it from answering any later render or describe — only a genuine re-interpretation
        /// can do that, and the host schedules one. Further live edits may keep using it: they are the same
        /// provisional picture, advancing with the user's drag.
        ///
        /// Refuses (Applied=false, no picture) unless an interpreted graph is cached for this form, its build is
        /// unchanged, and the picture it currently shows is the one the caller says it edited FROM. A refusal simply
        /// means "do the full render", which is always correct — so this can only ever be an optimization.
        /// </summary>
        public RenderLayoutResult ApplyInterpretedEdits(string designerFilePath, string assemblyPath, string rootTypeName,
            PropEdit[] edits, string expectedSourceKey, string newSourceKey, string[]? selectedTabs, int renderScale,
            int reqWidth, int reqHeight)
        {
            return _sta.Invoke(() =>
            {
                string key = InterpretedKey(designerFilePath, assemblyPath, rootTypeName);
                // An empty batch would mutate nothing and yet re-stamp the picture as a different buffer — a direct
                // caller could certify any text that way. There is nothing to apply, so there is nothing to certify.
                if (edits == null || edits.Length == 0) return NotApplied("no edits to apply");
                if (string.IsNullOrEmpty(expectedSourceKey) || string.IsNullOrEmpty(newSourceKey)
                    || !_cache.TryGetValue(key, out var live))
                    return NotApplied("no cached interpreted graph for this form");
                if (!IsFresh(live))
                {
                    // The same age bound render and describe obey. Without it, "describe (too old → fresh throwaway
                    // graph) then edit" quietly answered from a graph that had been sitting in the cache for minutes.
                    EvictInterpreted(key);
                    return NotApplied("the cached interpreted graph is too old to edit from");
                }
                string cultureName = SelectedCultureForDesigner(designerFilePath);
                if (live.PictureKey != SourceStamp(designerFilePath, cultureName, expectedSourceKey, selectedTabs, renderScale, reqWidth, reqHeight))
                    return NotApplied("the cached picture is not the buffer this edit started from");
                if (live.BuildId != ComputeBuildId(assemblyPath))
                {
                    EvictInterpreted(key); // rebuilt since: the graph's compiled types are the old build
                    return NotApplied("the assembly was rebuilt since this graph was interpreted");
                }

                _renderScale = renderScale;
                live.Mutated = true; // set BEFORE touching anything: a throw mid-batch must not leave it reusable
                var notes = new List<string>();
                try
                {
                    foreach (var e in edits)
                        if (!TryApply(live, e.ComponentId ?? "this", e.PropName ?? "", e.RawValue ?? "", out string reason)) notes.Add(reason);
                }
                catch (Exception ex)
                {
                    // A setter that THREW leaves the graph in a state neither buffer describes. Same treatment as a
                    // refused edit: no picture, and the graph goes — otherwise the next burst edit would chain from it.
                    EvictInterpreted(key);
                    return NotApplied("live edit threw " + ex.GetType().Name + ": " + ex.Message);
                }
                if (notes.Count > 0)
                {
                    // A partially applied batch is a picture of neither buffer. Return no picture at all and drop the
                    // graph, so the host's own re-render starts from source.
                    EvictInterpreted(key);
                    return NotApplied(string.Join("; ", notes));
                }
                live.Root.PerformLayout();
                Application.DoEvents();
                var r = Snapshot(live);
                r.Applied = true;
                live.PictureKey = SourceStamp(designerFilePath, cultureName, newSourceKey, selectedTabs, renderScale, reqWidth, reqHeight);
                return r;
            });
        }

        /// <summary>A refusal from the live-edit fast path: no picture, no cache mutation, a reason the host logs.</summary>
        private static RenderLayoutResult NotApplied(string reason)
            => new RenderLayoutResult { Applied = false, Diagnostics = reason, Png = Array.Empty<byte>() };

        /// <summary>Render the compiled last build and stamp it as a disclosed fallback (the interpreter couldn't
        /// cover this form). Reuses the exact compiled path so a fallback is byte-identical to a plain compiled render.</summary>
        private RenderLayoutResult CompiledFallback(string assemblyPath, string rootTypeName, int w, int h, string reason, string detail)
        {
            RenderLayoutResult r;
            try { r = Snapshot(GetOrCreate(assemblyPath, rootTypeName, w, h)); }
            catch (Exception ex)
            {
                // BOTH paths failed: the safe interpreted one bailed for `reason`, and constructing the user's real
                // form then threw too (a constructor that needs runtime services, say). Reporting only the second
                // exception hides WHY the safe path was abandoned — which is the actionable half, because that is the
                // gap to close for this form. Carry it into the message the user actually sees.
                throw new BothRenderPathsFailedException(
                    "the source could not be interpreted (" + reason
                    + (string.IsNullOrEmpty(detail) ? "" : ": " + detail)
                    + ") and the compiled fallback could not be built either — " + ex.GetBaseException().Message, ex);
            }
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
            string rootTypeName, string componentId, int reqWidth, int reqHeight, string sourceKey = "")
        {
            return _sta.Invoke(() =>
            {
                string cultureName = SelectedCultureForDesigner(designerFilePath);
                // 1.2.x — describe from the CACHED interpreted graph when it is provably this buffer's. Building a
                // throwaway graph here cost as much as a full render (~400 ms on a DevExpress form) and every drag
                // starts with a describe to read the control's current Location — so the reuse is the difference
                // between a drag that lands immediately and one that pays for two full interpretations.
                // The tab override, capture scale and requested size are deliberately NOT part of this comparison:
                // they change which page is SHOWN and how the picture is captured, not what a component's properties
                // are. A MUTATED graph is refused like everywhere else — describing live-edited values as if they were
                // the source's would report what a replay may never produce.
                string describeKey = InterpretedKey(designerFilePath, assemblyPath, rootTypeName);
                if (!string.IsNullOrEmpty(sourceKey) && _cache.TryGetValue(describeKey, out var cached))
                {
                    // An entry this describe will not use is DROPPED, not stepped over: leaving an aged-out graph in
                    // the cache let the edit that follows the describe answer from it.
                    if (cached.Mutated || !IsFresh(cached)) EvictInterpreted(describeKey);
                    else if (cached.BufferKey == BufferStamp(designerFilePath, cultureName, sourceKey)
                        && cached.Plan != null && cached.BuildId == ComputeBuildId(assemblyPath))
                    {
                        try { return DescribeInterpretedOn(cached.Plan, (Control)cached.Root, componentId ?? ""); }
                        catch { /* fall through to a fresh graph — a describe must never take the picture down with it */ }
                    }
                }

                Assembly asm;
                try { asm = Assembly.LoadFrom(Path.GetFullPath(assemblyPath)); } catch { return (ComponentDesc?)null; }
                var container = new DesignTimeContainer();
                var host = new AssemblyIrHost(ProbeAssembliesFor(asm), container, LoadSiblingResx(designerFilePath, cultureName), doc?.NamespaceContext);
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
                    // …and again AFTER the pump: a form can re-stage itself from a posted message (BeginInvoke, Shown,
                    // a vendor layout continuation), which lands here rather than inside Show.
                    ReassertRootWindow(builtForm, reqWidth, reqHeight);
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
            var exec = plan.Execution!;
            componentId = componentId ?? "";
            bool isRoot = componentId == "this" || componentId.Length == 0;
            var resolved = InterpretedDescribeResolver.Resolve(exec, plan.DesignedTypeName, root, componentId);
            IComponent? target = resolved?.Target;
            string name = resolved?.Name ?? (isRoot ? InterpretedDescribeResolver.ShortName(plan.DesignedTypeName) : componentId);
            string? parent = resolved?.Parent;
            var siblings = resolved?.Siblings;
            if (target == null)
            {
                object? value = null;
                if (isRoot) value = root;
                else exec.Instances.TryGetValue(componentId, out value);
                target = value as IComponent;
                if (target == null) return null;
                siblings = CurrentSourceSiblings(exec, target);
                parent = isRoot ? null : (target is Control ctl
                    ? InterpretedIdentityParent(ctl, root, exec, plan.DesignedTypeName)
                    : null);
            }

            string ownership = InterpretedOwnership(exec, root, componentId, target);
            var desc = CompiledDescriber.Describe(target, isRoot ? "this" : componentId, name, isRoot, parent,
                siblings ?? new List<KeyValuePair<string, IComponent>>(), root);
            return StampDescription(desc, ownership, target);
        }

        private static List<KeyValuePair<string, IComponent>> CurrentSourceSiblings(IrExecutionResult exec, IComponent target)
        {
            var siblings = new List<KeyValuePair<string, IComponent>>();
            foreach (var kv in exec.Instances)
            {
                if (kv.Key.Length == 0 || ReferenceEquals(kv.Value, target)) continue;
                if (exec.Origins.TryGetValue(kv.Key, out var origin)
                    && origin == IrOrigin.DeclaredInCurrentSource && kv.Value is IComponent component)
                    siblings.Add(new KeyValuePair<string, IComponent>(kv.Key, component));
            }
            siblings.Sort((a, b) => string.CompareOrdinal(a.Key, b.Key));
            return siblings;
        }

        private static string? InterpretedIdentityParent(Control control, Control root, IrExecutionResult exec, string designedTypeName)
        {
            for (Control? parent = control.Parent; parent != null; parent = parent.Parent)
            {
                if (ReferenceEquals(parent, root)) return InterpretedDescribeResolver.ShortName(designedTypeName);
                foreach (var kv in exec.Instances)
                    if (kv.Key.Length != 0 && ReferenceEquals(kv.Value, parent)) return kv.Key;
            }
            return null;
        }

        private static string InterpretedOwnership(IrExecutionResult exec, Control root, string componentId, IComponent target)
        {
            if (ReferenceEquals(target, root) || componentId == "this" || componentId.Length == 0)
                return InheritedOwnershipPolicy.Root;
            if (!exec.Origins.TryGetValue(componentId, out var origin)) return InheritedOwnershipPolicy.Unresolved;
            if (origin == IrOrigin.DeclaredInCurrentSource) return InheritedOwnershipPolicy.CurrentSource;
            if (origin == IrOrigin.Inherited) return InheritedOwnershipPolicy.Inherited;
            return origin == IrOrigin.Root ? InheritedOwnershipPolicy.Root : InheritedOwnershipPolicy.Unresolved;
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
                string cultureName = SelectedCultureForDesigner(designerFilePath);
                Assembly asm;
                try { asm = Assembly.LoadFrom(Path.GetFullPath(assemblyPath)); } catch { return new TabHit(); }
                var container = new DesignTimeContainer();
                var host = new AssemblyIrHost(ProbeAssembliesFor(asm), container, LoadSiblingResx(designerFilePath, cultureName), doc?.NamespaceContext);
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
                    ReassertRootWindow(builtForm, 0, 0); // a form can re-stage itself from a posted message — see above
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

        private static SafeResxResolver LoadSiblingResx(string designerFilePath, string cultureName)
        {
            return SafeResxResolver.Parse(MergedSiblingResxXml(designerFilePath, cultureName));
        }

        /// <summary>Apply transient tab VIEW STATE so a tab click survives the next interpreted render. Standard
        /// WinForms tabs use the typed path; vendor-shaped hosts use the same narrow public surface already required by
        /// layout/hit-test/live-move: a <c>TabPages</c> enumerable and a writable
        /// <c>SelectedTabPage</c>/<c>SelectedPage</c>/<c>SelectedTab</c> property. Both objects must be exact identities
        /// from the executor, and the page must be a reference-identical collection member. Invalid, foreign, oversized,
        /// throwing, or read-only shapes are harmless no-ops. Each entry is "hostFieldName=pageFieldName".</summary>
        private static void ApplyTabViewState(IrExecutionResult exec, string[]? selectedTabs)
        {
            if (selectedTabs == null) return;
            for (int i = 0; i < selectedTabs.Length && i < 128; i++)
            {
                string? pair = selectedTabs[i];
                if (string.IsNullOrEmpty(pair) || pair.Length > 513) continue;
                int eq = pair.IndexOf('=');
                if (eq <= 0 || eq != pair.LastIndexOf('=') || eq > 256 || pair.Length - eq - 1 > 256) continue;
                string hostName = pair.Substring(0, eq);
                string pageName = pair.Substring(eq + 1);
                if (exec.Instances.TryGetValue(hostName, out var h) && h is Control host
                    && exec.Instances.TryGetValue(pageName, out var p) && p is Control page)
                    TryApplyTabViewState(host, page);
            }
        }

        private static bool TryApplyTabViewState(Control host, Control page)
        {
            if (host is TabControl standardHost && page is TabPage standardPage)
            {
                if (!standardHost.TabPages.Contains(standardPage)) return false;
                try
                {
                    standardHost.SelectedTab = standardPage;
                    return ReferenceEquals(standardHost.SelectedTab, standardPage);
                }
                catch { return false; }
            }

            try
            {
                var pagesProp = FindTabProp(host.GetType(), "TabPages");
                var selectedProp = FindTabProp(host.GetType(), "SelectedTabPage", "SelectedPage", "SelectedTab");
                if (pagesProp == null || selectedProp?.GetSetMethod(nonPublic: false) == null
                    || !selectedProp.PropertyType.IsInstanceOfType(page)
                    || pagesProp.GetValue(host) is not System.Collections.IEnumerable pages) return false;

                bool member = false;
                int inspected = 0;
                foreach (var candidate in pages)
                {
                    if (inspected++ >= 512) return false;
                    if (ReferenceEquals(candidate, page)) { member = true; break; }
                }
                if (!member) return false;

                selectedProp.SetValue(host, page);
                return ReferenceEquals(selectedProp.GetValue(host), page);
            }
            catch { return false; }
        }

        /// <summary>Realize a root control off-screen so its handle tree (and vendor skinning) initializes exactly as
        /// at runtime — a Form hosted directly, any other Control wrapped in a borderless host form (mirrors Build).</summary>
        private static Form HostOffscreen(Control rootCtl, int reqWidth, int reqHeight)
        {
            Form form;
            if (rootCtl is Form rootForm)
            {
                HardenRootWindow(rootForm);
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
            try { ShowRealizing(form); }
            catch { if (!ReferenceEquals(form, rootCtl)) { try { form.Dispose(); } catch { } } throw; }
            ReassertRootWindow(form, reqWidth, reqHeight); // Show ran the form's own Load — it may have re-staged itself
            RegisterHostWindow(form);
            return form;
        }

        /// <summary>Remember a preview window as OURS, so the stray-window diagnostic never reports it as something a
        /// form opened. Every realized design stays alive on the render desktop for as long as it is cached.</summary>
        private static void RegisterHostWindow(Form form)
        {
            try
            {
                // Drop handles of previews that are gone. Without this the set only grows, and Windows RECYCLES window
                // handles — a reused HWND would then silently exclude a genuinely stray window from the diagnostic.
                IntPtr handle = form.Handle;
                lock (_hostWindowsGate)
                {
                    // Prune on EVERY registration, not past a threshold: Windows recycles window handles, and a dead
                    // entry that is later reused would make the diagnostics — and the rescue — treat a genuinely
                    // stray window as one of ours. The set is a handful of entries, so this costs nothing.
                    _hostWindows.RemoveWhere(h => !RenderDesktop.IsWindowAlive(h));
                    _hostWindows.Add(handle);
                }
            }
            catch { /* a form whose handle can't be read simply isn't excluded */ }
        }

        /// <summary>
        /// Neutralize the window states that make a real form escape the preview's off-screen placement — and that
        /// silently make it render at the WRONG size.
        ///
        /// A Maximized (or Minimized) form ignores Location and ClientSize outright: Windows sizes it to the monitor,
        /// so "off-screen at (-20000,-20000)" became a full-screen window at (-8,-8) and the captured picture was the
        /// SCREEN rather than the form the user designed (measured: 1936x1048 for a form asked to be 420x260). Visual
        /// Studio likewise draws the design size regardless of WindowState, so normalizing is also the faithful thing.
        /// TopMost would put the window above everything if it ever did reach a visible desktop.
        ///
        /// Each assignment is guarded on its own: a vendor form base can throw from a property setter, and one that
        /// does must not cost the rest of the hardening.
        /// </summary>
        private static void HardenRootWindow(Form form)
        {
            try { if (form.WindowState != FormWindowState.Normal) form.WindowState = FormWindowState.Normal; } catch { }
            try { if (form.TopMost) form.TopMost = false; } catch { }
            try { form.StartPosition = FormStartPosition.Manual; } catch { }
            try { form.ShowInTaskbar = false; } catch { }
            try { form.Location = new Point(-20000, -20000); } catch { }
        }

        /// <summary>Handles of the preview windows THIS engine hosts (one per realized design). Kept so the stray-window
        /// diagnostic can tell "a window the form opened" from "a preview we are hosting" — every previously rendered
        /// form is still alive on the render desktop, and without this the log accused each new form of opening them.</summary>
        private static readonly HashSet<IntPtr> _hostWindows = new HashSet<IntPtr>();
        /// <summary>Guards _hostWindows: the modal rescue below reads it from a pool thread while the render thread
        /// is blocked inside Show.</summary>
        private static readonly object _hostWindowsGate = new object();
        /// <summary>How long a realize may take before we assume a design-time window is waiting for an answer that
        /// can never come. Comfortably inside the host's 20s render timeout, so a rescued render still lands.</summary>
        private const int ModalRescueMs = 10000;

        /// <summary>
        /// Realize the window, and rescue this thread if the form's own design-time code blocks it.
        ///
        /// Show() runs the form's Load/Shown — and a MODAL window opened there waits for a click on a desktop that is
        /// never displayed, so Show would never return and the engine would be wedged for every later render too.
        /// The timer runs on a pool thread (this one is stuck by definition) and only ever asks windows this engine
        /// does NOT host to close.
        /// </summary>
        private static void ShowRealizing(Form form)
        {
            int renderThreadId = RenderDesktop.CurrentThreadId(); // captured HERE: the rescue runs on a pool thread
            // Register THIS preview BEFORE showing it. The rescue below closes every visible window on the render
            // thread that is not ours, and a modal opened from Shown (not Load) appears while Show is still blocked —
            // so a preview registered only after Show returned would be missing from the rescue's snapshot and be
            // closed as if it were the stray window. Touching Handle realizes the window without making it visible.
            RegisterHostWindow(form);
            using (var rescue = new System.Threading.Timer(_ =>
            {
                IntPtr[] ours;
                lock (_hostWindowsGate) { ours = new IntPtr[_hostWindows.Count]; _hostWindows.CopyTo(ours); }
                var closed = RenderDesktop.CloseStrayWindows(ours, renderThreadId);
                if (closed.Count > 0)
                    Console.Error.WriteLine("[engine:net48] a window the form opened at design time was blocking the preview — asked it to close: "
                        + string.Join(", ", closed.ToArray()));
            }, null, ModalRescueMs, System.Threading.Timeout.Infinite))
            {
                form.Show();
            }
        }

        /// <summary>Name the windows the form's design-time code opened for itself (a splash screen, a docking panel,
        /// a dialog). They are confined to the render desktop and never reach the screen, so the log is the only place
        /// they can be seen — and a modal one among them is exactly why a render would appear to hang. Diagnostics
        /// only; the host surfaces engine stderr in its output channel.</summary>
        private static void LogStrayWindows(Form host)
        {
            try
            {
                RegisterHostWindow(host);
                IntPtr[] ours;
                lock (_hostWindowsGate) { ours = new IntPtr[_hostWindows.Count]; _hostWindows.CopyTo(ours); }
                var titles = RenderDesktop.StrayWindows(ours, RenderDesktop.CurrentThreadId()); // called ON the render thread
                if (titles.Count == 0) return;
                Console.Error.WriteLine("[engine:net48] the form's design-time code opened "
                    + titles.Count + " window(s) — kept off-screen: " + string.Join(", ", titles.ToArray()));
            }
            catch { /* diagnostics must never affect a render */ }
        }

        /// <summary>Re-apply the hardening AFTER Show: Show is where the form's own Load/Shown code runs, and that code
        /// routinely maximizes, centers or re-stages the window (this engine renders the real type, so it really does
        /// run). Restores the requested client size, which a WindowState change would otherwise have discarded.</summary>
        private static void ReassertRootWindow(Form form, int reqWidth, int reqHeight)
        {
            try
            {
                // Re-applied UNCONDITIONALLY. A "looks untouched" shortcut (Normal + still off-screen) misses the
                // properties that leave no trace in those two: a ClientSize the form changed in Load, a TopMost it
                // set, a taskbar button it asked for. Each assignment is already a no-op when nothing changed.
                HardenRootWindow(form);
                if (reqWidth > 0 && reqHeight > 0 && form.ClientSize != new Size(reqWidth, reqHeight))
                    form.ClientSize = new Size(reqWidth, reqHeight);
            }
            catch { /* best-effort: a vendor form that refuses is still confined to the render desktop */ }
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
        /// failure, so the host simply shows no vendor section.
        ///
        /// PEEKS the live instance, never builds one. This is optional metadata for a menu, and building the instance
        /// means constructing the user's REAL compiled form and realizing it — which runs their constructor, their
        /// field initializers and their Load handler. That is a heavy, side-effecting act (their Load legitimately
        /// opens splash screens and dialogs), and it must never be triggered by merely SELECTING a control on a
        /// preview that was drawn by interpreting the source. When a compiled instance already exists — the canvas
        /// IS that instance — answering costs nothing and the menu appears as before.</summary>
        public VendorSmartTag[] ListVendorSmartTags(string assemblyPath, string rootTypeName, string componentId)
        {
            return _sta.Invoke(() =>
            {
                try
                {
                    var live = PeekLive(assemblyPath, rootTypeName);
                    if (live == null) return Array.Empty<VendorSmartTag>();
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
                if (!TryResolveEditableControl(live, componentId, out Control? owner, out string ownershipReason))
                    return Note(live, ownershipReason);
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
                col.DataPropertyName = it.DataPropertyName ?? "";
                col.DefaultCellStyle.Format = it.Format ?? "";
                col.DefaultCellStyle.NullValue = it.NullValue ?? "";
                if (!string.IsNullOrEmpty(it.Alignment)
                    && Enum.TryParse(it.Alignment, out DataGridViewContentAlignment alignment))
                    col.DefaultCellStyle.Alignment = alignment;
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
                if (!TryResolveEditableControl(live, componentId, out Control? owner, out string ownershipReason))
                    return Note(live, ownershipReason);
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
                if (!TryResolveEditableTarget(live, componentId, out IComponent? editableTarget, out string ownershipReason))
                    return Note(live, ownershipReason);
                if (!(editableTarget is ImageList target)) return Note(live, "no ImageList '" + componentId + "'");
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
                if (!TryResolveEditableControl(live, componentId, out Control? owner, out string ownershipReason))
                    return Note(live, ownershipReason);
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
                if (!TryResolveEditableControl(live, componentId, out Control? owner, out string ownershipReason))
                    return Note(live, ownershipReason);
                if (!(owner is ToolStrip strip)) return Note(live, "'" + componentId + "' is not a ToolStrip");
                foreach (ToolStripItem existing in EnumerateToolStripItems(strip.Items))
                {
                    string existingOwnership = OwnershipOf(live, existing);
                    if (!InheritedOwnershipPolicy.IsEditable(existingOwnership))
                        return Note(live, "cannot update items on " + componentId + ": "
                            + InheritedOwnershipPolicy.ReadOnlyReason(existingOwnership));
                }
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
                    foreach (var reg in registers)
                    {
                        live.FieldNames[reg.Key] = reg.Value;
                        live.Ownership[reg.Key] = InheritedOwnershipPolicy.CurrentSource;
                    }
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
            live.Ownership.Remove(item);
            if (item is ToolStripDropDownItem ddi)
                foreach (ToolStripItem child in ddi.DropDownItems)
                    RemoveItemFieldEntries(child, live);
        }

        private static IEnumerable<ToolStripItem> EnumerateToolStripItems(ToolStripItemCollection items)
        {
            foreach (ToolStripItem item in items)
            {
                yield return item;
                if (item is ToolStripDropDownItem dropDown && dropDown.HasDropDownItems)
                    foreach (var child in EnumerateToolStripItems(dropDown.DropDownItems)) yield return child;
            }
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
                    if (TryResolveEditableControl(live, id ?? "", out Control? ctl, out string ownershipReason)
                        && !ReferenceEquals(ctl, live.Root) && ctl.Parent != null)
                    {
                        var subtree = new List<Control>();
                        Collect(ctl, subtree);
                        var blocked = subtree.FirstOrDefault(child => live.FieldNames.ContainsKey(child)
                            && !InheritedOwnershipPolicy.IsEditable(OwnershipOf(live, child)));
                        if (blocked != null)
                        {
                            notes.Add("cannot remove '" + id + "': "
                                + InheritedOwnershipPolicy.ReadOnlyReason(OwnershipOf(live, blocked)));
                            continue;
                        }
                        ctl.Parent.Controls.Remove(ctl);
                        foreach (var child in subtree)
                        {
                            if (live.FieldNames.TryGetValue(child, out var childId))
                            {
                                live.ByField.Remove(childId);
                                live.FieldNames.Remove(child);
                            }
                            live.Ownership.Remove(child);
                        }
                        try { ctl.Dispose(); } catch { /* best effort */ }
                    }
                    else notes.Add(ownershipReason.Length > 0 ? ownershipReason : "cannot remove '" + id + "'");
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
                var notes = new List<string>();
                foreach (var id in ids)
                {
                    if (TryResolveEditableControl(live, id ?? "", out Control? ctl, out string ownershipReason)
                        && !ReferenceEquals(ctl, live.Root))
                    {
                        if (toFront) ctl.BringToFront(); else ctl.SendToBack();
                    }
                    else notes.Add(ownershipReason.Length > 0 ? ownershipReason : "cannot change z-order of '" + id + "'");
                }
                live.Root.PerformLayout();
                Application.DoEvents();
                var result = Snapshot(live);
                result.Applied = notes.Count == 0;
                if (notes.Count > 0) result.Diagnostics = string.Join("; ", notes);
                return result;
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
                if (!TryResolveEditableControl(live, parentId, out Control? parent, out string ownershipReason))
                    return Note(live, ownershipReason);
                if (!string.IsNullOrEmpty(newId) && live.FieldNames.Any(kv => kv.Value == newId))
                    return Note(live, "component id is already present: " + newId);

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
                        live.Ownership[ctl] = InheritedOwnershipPolicy.CurrentSource;
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
                if (!TryResolveEditableControl(live, hostId, out Control? host, out string ownershipReason))
                    return Note(live, ownershipReason);
                if (!string.IsNullOrEmpty(newId) && live.FieldNames.Any(kv => kv.Value == newId))
                    return Note(live, "component id is already present: " + newId);
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
                    if (!string.IsNullOrEmpty(newId))
                    {
                        live.FieldNames[page] = newId;
                        live.ByField[newId] = page;
                        live.Ownership[page] = InheritedOwnershipPolicy.CurrentSource;
                    }
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
                if (!TryResolveEditableControl(live, hostId, out Control? host, out string hostOwnershipReason))
                    return Note(live, hostOwnershipReason);
                if (!TryResolveEditableControl(live, pageId, out Control? page, out string pageOwnershipReason))
                    return Note(live, pageOwnershipReason);
                var subtree = new List<Control>();
                Collect(page, subtree); // page + descendants — captured BEFORE detach/dispose while Controls is intact
                foreach (var child in subtree)
                {
                    if (!live.FieldNames.ContainsKey(child)) continue;
                    string childOwnership = OwnershipOf(live, child);
                    if (!InheritedOwnershipPolicy.IsEditable(childOwnership))
                        return Note(live, "cannot remove tab '" + pageId + "': "
                            + InheritedOwnershipPolicy.ReadOnlyReason(childOwnership));
                }
                if (!TryRemoveTabPage(host, page)) return Note(live, "could not remove tab '" + pageId + "'");
                foreach (var c in subtree)
                {
                    if (live.FieldNames.TryGetValue(c, out var fid)) { live.ByField.Remove(fid); live.FieldNames.Remove(c); }
                    live.Ownership.Remove(c);
                }
                try { page.Dispose(); } catch { /* best effort */ }
                live.Root.PerformLayout();
                Application.DoEvents();
                var r = Snapshot(live);
                r.Applied = true;
                return r;
            });
        }

        /// <summary>Move one existing tab page a single position left/right in the LIVE compiled-preview collection,
        /// preserve the active page, and re-render. The persisted order is still the net10 pure-text splice; this
        /// method mirrors it only while a net48 canvas is on the disclosed compiled fallback.</summary>
        public RenderLayoutResult MoveTab(string assemblyPath, string rootTypeName, string hostId, string pageId, bool left)
        {
            return _sta.Invoke(() =>
            {
                var live = GetOrCreate(assemblyPath, rootTypeName, 0, 0);
                if (!TryResolveEditableControl(live, hostId, out Control? host, out string hostOwnershipReason))
                    return Note(live, hostOwnershipReason);
                if (!TryResolveEditableControl(live, pageId, out Control? page, out string pageOwnershipReason))
                    return Note(live, pageOwnershipReason);
                if (!TryMoveTabPage(host, page, left, out bool moved, out string reason))
                    return Note(live, reason);
                if (!moved) return Note(live, "tab is already at the requested edge");
                live.Root.PerformLayout();
                Application.DoEvents();
                var result = Snapshot(live);
                result.Applied = true;
                return result;
            });
        }

        /// <summary>Reflection-bounded collection move for standard TabPageCollection and vendor equivalents. Prefer
        /// a native Move(old,new), otherwise use IList or canonical RemoveAt+Insert. A failed two-step mutation attempts
        /// to restore the page at its original index before returning false.</summary>
        private static bool TryMoveTabPage(Control host, Control page, bool left, out bool moved, out string reason)
        {
            moved = false; reason = "could not reorder tab";
            var pagesProp = FindTabProp(host.GetType(), "TabPages");
            var coll = pagesProp?.GetValue(host);
            if (coll == null) { reason = "not a tab host: " + host.Name; return false; }

            var selectedProp = FindTabProp(host.GetType(), "SelectedTabPage", "SelectedPage", "SelectedTab");
            object? selected = null;
            try { selected = selectedProp?.GetValue(host); } catch { /* selection restore is best effort */ }

            int index;
            int count;
            if (coll is IList list)
            {
                index = list.IndexOf(page);
                count = list.Count;
            }
            else
            {
                var indexOf = coll.GetType().GetMethods().FirstOrDefault(m => m.Name == "IndexOf"
                    && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType.IsInstanceOfType(page));
                var countProp = coll.GetType().GetProperty("Count", BindingFlags.Public | BindingFlags.Instance);
                if (indexOf == null || countProp == null)
                { reason = "tab collection has no bounded IndexOf/Count surface"; return false; }
                try
                {
                    index = Convert.ToInt32(indexOf.Invoke(coll, new object[] { page }), CultureInfo.InvariantCulture);
                    count = Convert.ToInt32(countProp.GetValue(coll), CultureInfo.InvariantCulture);
                }
                catch (Exception ex) { reason = "could not inspect tab collection: " + ex.Message; return false; }
            }
            if (index < 0 || index >= count) { reason = "page is not a member of tab host"; return false; }
            int target = left ? index - 1 : index + 1;
            if (target < 0 || target >= count) { moved = false; reason = "tab is already at the requested edge"; return true; }

            try
            {
                var nativeMove = coll.GetType().GetMethods().FirstOrDefault(m => m.Name == "Move"
                    && m.GetParameters().Length == 2
                    && m.GetParameters()[0].ParameterType == typeof(int)
                    && m.GetParameters()[1].ParameterType == typeof(int));
                if (nativeMove != null)
                {
                    nativeMove.Invoke(coll, new object[] { index, target });
                }
                else if (coll is IList mutable)
                {
                    object moving = mutable[index]!;
                    mutable.RemoveAt(index);
                    try { mutable.Insert(target, moving); }
                    catch
                    {
                        try { mutable.Insert(Math.Min(index, mutable.Count), moving); } catch { /* live preview will rebuild */ }
                        throw;
                    }
                }
                else
                {
                    var removeAt = coll.GetType().GetMethod("RemoveAt", new[] { typeof(int) });
                    var insert = coll.GetType().GetMethods().FirstOrDefault(m => m.Name == "Insert"
                        && m.GetParameters().Length == 2
                        && m.GetParameters()[0].ParameterType == typeof(int)
                        && m.GetParameters()[1].ParameterType.IsInstanceOfType(page));
                    if (removeAt == null || insert == null)
                    { reason = "tab collection has no Move or RemoveAt+Insert surface"; return false; }
                    removeAt.Invoke(coll, new object[] { index });
                    try { insert.Invoke(coll, new object[] { target, page }); }
                    catch
                    {
                        try { insert.Invoke(coll, new object[] { index, page }); } catch { /* live preview will rebuild */ }
                        throw;
                    }
                }
                if (selected != null && selectedProp?.CanWrite == true)
                    try { selectedProp.SetValue(host, selected); } catch { /* preserve order even if vendor rejects reselection */ }
                moved = true;
                reason = "";
                return true;
            }
            catch (Exception ex)
            {
                reason = "could not reorder tab: " + (ex.InnerException?.Message ?? ex.Message);
                return false;
            }
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
            if (!TryResolveEditableTarget(live, componentId, out IComponent? target, out reason)) return false;
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
                        string referencedOwnership = OwnershipOf(live, inst);
                        if (!InheritedOwnershipPolicy.IsEditable(referencedOwnership))
                        {
                            reason = "cannot reference '" + refName + "': " + InheritedOwnershipPolicy.ReadOnlyReason(referencedOwnership);
                            return false;
                        }
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
            if (!TryResolveEditableTarget(live, componentId, out IComponent? target, out reason)) return false;
            if (!(target is Control || target is ToolStripItem))
            { reason = "no control '" + componentId + "'"; return false; }
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

        /// <summary>The cached live design for (assembly, type) IF one already exists — never builds. For callers that
        /// want to READ from a compiled instance the preview already has, without being the reason one gets built:
        /// building means running the user's real form (see ListVendorSmartTags). Must be called on the STA, like
        /// every other read of the cache.</summary>
        private LiveDesign? PeekLive(string assemblyPath, string rootTypeName)
        {
            string key;
            try { key = Path.GetFullPath(assemblyPath) + "|" + rootTypeName; } catch { return null; }
            return _cache.TryGetValue(key, out var live) ? live : null;
        }

        private LiveDesign GetOrCreate(string assemblyPath, string rootTypeName, int reqWidth, int reqHeight)
        {
            string key = Path.GetFullPath(assemblyPath) + "|" + rootTypeName;
            // The REQUESTED size is part of what Build produces (it sizes the hosting form), so a cached instance
            // built for one size cannot answer a request for another. The extension always asks for 0×0 ("use the
            // form's own size"), but the RPC is public: a caller that asked for 300×200 and then 800×600 used to get
            // the first picture twice. Rebuild instead of handing back a differently-sized graph.
            if (_cache.TryGetValue(key, out var live))
            {
                if (live.ReqWidth == reqWidth && live.ReqHeight == reqHeight) return live;
                _cache.Remove(key);
                try { live.Form?.Dispose(); } catch { /* the entry is already dropped */ }
            }
            live = Build(assemblyPath, rootTypeName, reqWidth, reqHeight);
            live.ReqWidth = reqWidth;
            live.ReqHeight = reqHeight;
            _cache[key] = live;
            return live;
        }

        /// <summary>0.11.0 net48 undo reconcile — drop the cached live instance for (assembly, type) so the NEXT render
        /// re-instantiates from the compiled baseline. The host calls this after an undo/redo/revert reverts the
        /// .Designer.cs text: the cached instance still carries the live mutations of the now-reverted edit (net48
        /// renders the compiled INSTANCE, not the text), so reusing it would keep showing the undone change. Disposing
        /// the form releases its GDI/window handles. Returns true if an entry was actually dropped.</summary>
        public bool DiscardLive(string assemblyPath, string rootTypeName, string designerFilePath = "")
        {
            // ON THE STA, like every other operation that touches the cache or a realized control tree. Called from the
            // RPC thread, it could remove and dispose a Form while a render or a live edit was still pumping messages
            // on it — a cross-thread teardown of live HWNDs, plus an unsynchronized write to the dictionary.
            return _sta.Invoke(() =>
            {
                string key;
                try { key = Path.GetFullPath(assemblyPath) + "|" + rootTypeName; } catch { return false; }
                // The INTERPRETED graph is dropped for the same reason: it carries the live mutations of an edit the
                // host has just reverted, and its key no longer names any buffer the user can produce. The designer
                // path may be absent (older callers): then drop every interpreted entry for this assembly + type.
                bool dropped = false;
                if (!string.IsNullOrEmpty(designerFilePath))
                {
                    string ik = InterpretedKey(designerFilePath, assemblyPath, rootTypeName);
                    if (_cache.ContainsKey(ik)) { EvictInterpreted(ik); dropped = true; }
                }
                else
                {
                    foreach (var k in _cache.Keys.Where(x => x.StartsWith("interpreted|", StringComparison.Ordinal)
                                                             && x.EndsWith("|" + rootTypeName, StringComparison.Ordinal)).ToList())
                    { EvictInterpreted(k); dropped = true; }
                }
                if (!_cache.TryGetValue(key, out var live)) return dropped; // an interpreted-only drop is still a drop
                _cache.Remove(key);
                try { live.Form?.Dispose(); } catch { /* best effort — the entry is already dropped */ }
                return true;
            });
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
            var ownership = BuildOwnershipMap(instance, type);
            ownership[rootCtl] = InheritedOwnershipPolicy.Root;

            Form form;
            if (rootCtl is Form rootForm)
            {
                // The root type is ITSELF a top-level window (a Form / DevExpress XtraForm, e.g. WellTieForm).
                // A Form cannot be added as a child of another control — WinForms throws "Top-level control
                // cannot be added to a control". So host it DIRECTLY: realize it off-screen and snapshot the
                // whole window. This mirrors the net9 engine, whose RootComponent for a form-based .Designer.cs
                // IS the Form itself (it draws root.DrawToBitmap on the form), and ComputeWindowOffset already
                // accounts for a form's chrome (window-vs-client size), so child rects line up either way.
                // …and normalize the window state first: a Maximized form ignores both the off-screen Location and the
                // requested ClientSize, so it used to be realized full-screen — visible to the user AND captured at
                // monitor size instead of the designed size. See HardenRootWindow.
                HardenRootWindow(rootForm);
                if (reqWidth > 0 && reqHeight > 0) rootForm.ClientSize = new Size(reqWidth, reqHeight);
                form = rootForm;
                ShowRealizing(form); // realizes the whole control tree's handles, off-screen (with a modal rescue)
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
                ShowRealizing(form); // realizes the whole control tree's handles, off-screen (with a modal rescue)
            }

            for (int i = 0; i < 20; i++) { Application.DoEvents(); Thread.Sleep(10); }
            // The form's own Load/Shown ran during Show + this pump. If it re-staged the window (maximize, centre,
            // TopMost — all common in a real application's main form), put it back before anything measures or
            // captures it. Any window that code opened of its own is confined to the render desktop; name them in the
            // log, because such a form can also be the reason a render blocks.
            ReassertRootWindow(form, reqWidth, reqHeight);
            LogStrayWindows(form);
            rootCtl.PerformLayout();
            Application.DoEvents();

            var byField = BuildControlIndex(fieldNames, out var ambiguousIds);

            return new LiveDesign
            {
                Form = form,
                Root = rootCtl,
                Type = type,
                FieldNames = fieldNames,
                ByField = byField,
                AmbiguousIds = ambiguousIds,
                Ownership = ownership,
                BuildId = ComputeBuildId(assemblyPath),
            };
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
            // A graph that stated its own scale (the interpreted cache, which may be snapshotted by a live edit that
            // never restates it) wins; a compiled graph has none, so the current request's scale applies — anything
            // else silently captured every compiled and fallback preview at 1x on a HiDPI display.
            byte[] png = CaptureScaledPng(root, w, h, live.Scale > 0 ? live.Scale : _renderScale);

            string rootClassName = live.DesignedTypeName != null ? InterpretedDescribeResolver.ShortName(live.DesignedTypeName) : live.Type.Name;
            var controls = BuildLayoutControls(live, rootClassName, w, h);
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
            return StampDescription(
                CompiledDescriber.Describe(target, isRoot ? "this" : componentId, name, isRoot, parent, siblings, live.Root),
                OwnershipOf(live, target), target);
        }

        private static ComponentDesc StampDescription(ComponentDesc desc, string ownership, IComponent target)
        {
            desc.Ownership = ownership;
            desc.Editable = InheritedOwnershipPolicy.IsEditable(ownership);
            desc.ReadOnlyReason = InheritedOwnershipPolicy.ReadOnlyReason(ownership);
            EnrichPropertyMetadata(desc, target, desc.Editable);
            if (!desc.Editable && desc.Properties != null)
                foreach (var property in desc.Properties)
                    if (property != null)
                    {
                        property.ReadOnly = true;
                        property.UiTypeEditor = null;
                        ForceExpandableReadOnly(property.Properties);
                    }
            return desc;
        }

        private static readonly HashSet<string> GenericListSupportedItemTypes = new HashSet<string>(StringComparer.Ordinal)
        {
            "System.String", "System.Boolean", "System.Char", "System.SByte", "System.Byte",
            "System.Int16", "System.UInt16", "System.Int32", "System.UInt32", "System.Int64",
            "System.UInt64", "System.Single", "System.Double", "System.Decimal",
            "System.Windows.Forms.AnchorStyles", "System.Windows.Forms.DockStyle", "System.Windows.Forms.CheckState",
            "System.Windows.Forms.DialogResult", "System.Windows.Forms.FormBorderStyle", "System.Windows.Forms.ComboBoxStyle",
            "System.Windows.Forms.FlatStyle", "System.Windows.Forms.ScrollBars", "System.Windows.Forms.BorderStyle",
            "System.Windows.Forms.Orientation", "System.Windows.Forms.HorizontalAlignment",
            "System.Windows.Forms.DataGridViewContentAlignment", "System.Windows.Forms.Keys",
            "System.Drawing.FontStyle", "System.Drawing.GraphicsUnit", "System.Drawing.ContentAlignment",
            "System.Drawing.Drawing2D.DashStyle", "System.Drawing.Point", "System.Drawing.Size",
            "System.Drawing.Color", "System.Drawing.Rectangle", "System.Windows.Forms.Padding",
            "System.Drawing.Font", "System.Windows.Forms.Cursor",
        };

        private static readonly HashSet<string> ExpandableSourceValueTypes = new HashSet<string>(StringComparer.Ordinal)
        {
            "System.Drawing.Point", "System.Drawing.Size", "System.Drawing.Color", "System.Drawing.Rectangle",
            "System.Windows.Forms.Padding", "System.Drawing.Font", "System.Windows.Forms.Cursor",
        };

        private static void EnrichPropertyMetadata(ComponentDesc desc, IComponent target, bool componentEditable)
        {
            if (desc.Properties == null || desc.Properties.Count == 0) return;
            PropertyDescriptorCollection descriptors;
            try { descriptors = TypeDescriptor.GetProperties(target); }
            catch { return; }

            foreach (var property in desc.Properties)
            {
                if (property == null || string.IsNullOrEmpty(property.Name)) continue;
                PropertyDescriptor? descriptor;
                try { descriptor = descriptors[property.Name]; } catch { descriptor = null; }
                if (descriptor == null) continue; // extender/source pseudo-property, not a live descriptor

                object? raw;
                try { raw = descriptor.GetValue(target); } catch { raw = null; }

                DesignerSerializationVisibilityAttribute? visibility;
                try
                {
                    visibility = (DesignerSerializationVisibilityAttribute?)descriptor.Attributes[
                        typeof(DesignerSerializationVisibilityAttribute)];
                }
                catch { visibility = null; }

                if (!property.IsCollection && !property.TableCell
                    && visibility?.Visibility == DesignerSerializationVisibility.Content
                    && IsGenericListShape(descriptor.PropertyType))
                {
                    string? itemType = GenericCollectionItemType(descriptor.PropertyType);
                    if (itemType != null)
                    {
                        property.IsCollection = true;
                        property.GenericCollection = true;
                        property.CollectionItemType = itemType;
                        property.Value = null;
                        property.ReadOnly = !componentEditable;
                    }
                }

                property.UiTypeEditor = componentEditable && !property.ReadOnly
                    && descriptor.PropertyType == typeof(System.Drawing.Color)
                        ? "System.Drawing.Design.ColorEditor"
                        : componentEditable && !property.ReadOnly
                            && descriptor.PropertyType == typeof(System.Drawing.Font)
                                ? "System.Drawing.Design.FontEditor"
                                : null;

                bool suppressExpansion = property.TableCell || property.IsCollection || property.IsImage
                    || property.ReferenceValues || property.IsDataSource;
                var expansion = ExpandablePropertiesOf(descriptor, target, raw, descriptor.Name,
                    suppressExpansion, componentEditable);
                property.Properties = expansion.Properties;
                property.PropertiesTruncated = expansion.Truncated;
            }
        }

        private static bool IsGenericListShape(Type type)
        {
            try
            {
                if (typeof(IList).IsAssignableFrom(type)) return true;
                if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(IList<>)) return true;
                return type.GetInterfaces().Any(i => i.IsGenericType && i.GetGenericTypeDefinition() == typeof(IList<>));
            }
            catch { return false; }
        }

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
                    var addTypes = collectionType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
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
                return name != null && GenericListSupportedItemTypes.Contains(name) ? name : null;
            }
            catch { return null; }
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

        private sealed class ExpandableResult
        {
            public List<ExpandablePropertyDesc>? Properties;
            public bool Truncated;
        }

        private static ExpandableResult ExpandablePropertiesOf(PropertyDescriptor descriptor, object owner, object? raw,
            string path, bool suppressForBespokeEditor, bool componentEditable)
        {
            if (suppressForBespokeEditor || raw == null) return new ExpandableResult();
            var budget = new ExpandableBudget(ExpandableMaxNodes);
            var visited = new HashSet<object>(ReferenceEqualityComparer.Instance);
            bool truncated = false;
            var properties = ExpandablePropertiesOf(descriptor, owner, raw, path, 0, budget, visited,
                componentEditable, ref truncated);
            return new ExpandableResult { Properties = properties, Truncated = truncated };
        }

        private static List<ExpandablePropertyDesc>? ExpandablePropertiesOf(PropertyDescriptor ownerDescriptor,
            object owner, object raw, string path, int depth, ExpandableBudget budget, HashSet<object> visited,
            bool componentEditable, ref bool truncated)
        {
            if (depth >= ExpandableMaxDepth) { truncated = true; return null; }
            if (!TryEnterExpandable(raw, visited)) return null;
            try
            {
                TypeConverter? converter;
                try { converter = ownerDescriptor.Converter; } catch { converter = null; }
                if (converter == null) return null;
                var context = new ExpandableDescribeContext(owner, ownerDescriptor);
                if (!ConverterPropertiesSupported(converter, context)) return null;
                var children = ConverterProperties(converter, context, raw);
                if (children == null || children.Count == 0) return null;

                var result = new List<ExpandablePropertyDesc>();
                int emittedForNode = 0;
                foreach (PropertyDescriptor child in children)
                {
                    if (emittedForNode >= ExpandableMaxChildrenPerNode) { truncated = true; break; }
                    if (!budget.TryTake()) { truncated = true; break; }
                    if (!ShouldSurfaceExpandableChild(child)) continue;

                    string childPath = BoundString(JoinPropertyPath(path, child.Name), ExpandableMaxPathChars);
                    object? childRaw;
                    try { childRaw = child.GetValue(raw); } catch { childRaw = null; }
                    string? childValue;
                    try { childValue = BoundNullable(StringifyInvariant(child, childRaw), ExpandableMaxValueChars); }
                    catch { childValue = null; }

                    bool descriptorReadOnly;
                    try { descriptorReadOnly = child.IsReadOnly; } catch { descriptorReadOnly = true; }
                    bool childReadOnly = !componentEditable || descriptorReadOnly;
                    var standards = ExpandableStandardValues(child, raw);

                    string? description;
                    try { description = BoundNullable(string.IsNullOrEmpty(child.Description) ? null : child.Description, ExpandableMaxDescriptionChars); }
                    catch { description = null; }
                    string category;
                    try { category = BoundString(string.IsNullOrEmpty(child.Category) ? "Misc" : child.Category, ExpandableMaxCategoryChars); }
                    catch { category = "Misc"; }

                    bool nestedTruncated = false;
                    var nested = childRaw == null ? null : ExpandablePropertiesOf(child, raw, childRaw, childPath,
                        depth + 1, budget, visited, componentEditable, ref nestedTruncated);
                    if (nestedTruncated) truncated = true;

                    result.Add(new ExpandablePropertyDesc
                    {
                        Name = BoundString(child.Name, ExpandableMaxNameChars),
                        PropertyPath = childPath,
                        Type = BoundString(child.PropertyType.FullName ?? child.PropertyType.Name, ExpandableMaxTypeChars),
                        Value = childValue,
                        ReadOnly = childReadOnly,
                        SourceEditable = componentEditable
                            && SourceEditableThroughExistingValueConversion(child.PropertyType, childValue, descriptorReadOnly),
                        Category = category,
                        Description = description,
                        StandardValues = standards.Values,
                        StandardValuesExclusive = standards.Exclusive,
                        Properties = nested,
                        PropertiesTruncated = nestedTruncated,
                    });
                    emittedForNode++;
                }
                result.Sort((a, b) => string.CompareOrdinal(a.Name, b.Name));
                return result.Count == 0 ? null : result;
            }
            catch { return null; }
            finally { ExitExpandable(raw, visited); }
        }

        private static bool ConverterPropertiesSupported(TypeConverter converter, ITypeDescriptorContext context)
        {
            try { return converter.GetPropertiesSupported(context); }
            catch { try { return converter.GetPropertiesSupported(); } catch { return false; } }
        }

        private static PropertyDescriptorCollection? ConverterProperties(TypeConverter converter,
            ITypeDescriptorContext context, object value)
        {
            try { return converter.GetProperties(context, value, Array.Empty<Attribute>()); }
            catch { try { return converter.GetProperties(value); } catch { return null; } }
        }

        private static bool ShouldSurfaceExpandableChild(PropertyDescriptor descriptor)
        {
            try { if (!descriptor.IsBrowsable) return false; } catch { return false; }
            try
            {
                var visibility = (DesignerSerializationVisibilityAttribute?)descriptor.Attributes[
                    typeof(DesignerSerializationVisibilityAttribute)];
                return visibility == null || visibility.Visibility != DesignerSerializationVisibility.Hidden;
            }
            catch { return false; }
        }

        private sealed class ExpandableStandardValuesResult
        {
            public List<string>? Values;
            public bool Exclusive;
        }

        private static ExpandableStandardValuesResult ExpandableStandardValues(PropertyDescriptor descriptor, object owner)
        {
            try
            {
                if (descriptor.PropertyType.IsEnum
                    && descriptor.PropertyType.IsDefined(typeof(FlagsAttribute), false)) return new ExpandableStandardValuesResult();
                TypeConverter? converter;
                try { converter = descriptor.Converter; } catch { converter = null; }
                if (converter == null) return new ExpandableStandardValuesResult();
                var context = new ExpandableDescribeContext(owner, descriptor);
                System.Collections.ICollection? collection;
                try { collection = converter.GetStandardValuesSupported(context) ? converter.GetStandardValues(context) : null; }
                catch { try { collection = converter.GetStandardValuesSupported() ? converter.GetStandardValues() : null; } catch { collection = null; } }
                if (collection == null) return new ExpandableStandardValuesResult();

                var values = new List<string>();
                foreach (var item in collection)
                {
                    if (item == null) continue;
                    string? value;
                    try { value = converter.CanConvertTo(typeof(string)) ? converter.ConvertToInvariantString(item) : null; }
                    catch { value = null; }
                    if (string.IsNullOrEmpty(value) || value.Length > ExpandableMaxValueChars) continue;
                    if (!values.Contains(value)) values.Add(value);
                    if (values.Count >= ExpandableMaxStandardValues) break;
                }
                if (values.Count == 0) return new ExpandableStandardValuesResult();
                bool exclusive;
                try { exclusive = converter.GetStandardValuesExclusive(context); }
                catch { try { exclusive = converter.GetStandardValuesExclusive(); } catch { exclusive = false; } }
                return new ExpandableStandardValuesResult { Values = values, Exclusive = exclusive };
            }
            catch { return new ExpandableStandardValuesResult(); }
        }

        private static string? StringifyInvariant(PropertyDescriptor descriptor, object? value)
        {
            if (value == null) return null;
            TypeConverter? converter;
            try { converter = descriptor.Converter; } catch { converter = null; }
            if (converter == null || !converter.CanConvertTo(typeof(string))) return null;
            return converter.ConvertToInvariantString(value);
        }

        private static bool SourceEditableThroughExistingValueConversion(Type type, string? value, bool readOnly)
        {
            if (readOnly || string.IsNullOrEmpty(value) || value.Length > ExpandableMaxValueChars
                || type.FullName == null || !ExpandableSourceValueTypes.Contains(type.FullName)) return false;
            try
            {
                TypeConverter converter = TypeDescriptor.GetConverter(type);
                if (!converter.CanConvertFrom(typeof(string))
                    || !converter.CanConvertTo(typeof(System.ComponentModel.Design.Serialization.InstanceDescriptor))) return false;
                object? parsed = converter.ConvertFromInvariantString(value);
                if (parsed == null) return false;
                if (parsed is System.Drawing.Font font)
                {
                    if (font.GdiCharSet != 1 || font.GdiVerticalFont) return false;
                    string requestedFamily = value.Split(',')[0].Trim();
                    if (requestedFamily.Length > 0
                        && !string.Equals(font.Name, requestedFamily, StringComparison.OrdinalIgnoreCase)) return false;
                }
                var descriptor = converter.ConvertTo(parsed,
                    typeof(System.ComponentModel.Design.Serialization.InstanceDescriptor))
                    as System.ComponentModel.Design.Serialization.InstanceDescriptor;
                return descriptor?.MemberInfo != null;
            }
            catch { return false; }
        }

        private static bool TryEnterExpandable(object value, HashSet<object> visited)
        {
            Type type;
            try { type = value.GetType(); } catch { return false; }
            return type.IsValueType || visited.Add(value);
        }

        private static void ExitExpandable(object value, HashSet<object> visited)
        {
            try { if (!value.GetType().IsValueType) visited.Remove(value); } catch { }
        }

        private static void ForceExpandableReadOnly(List<ExpandablePropertyDesc>? properties)
        {
            if (properties == null) return;
            foreach (var property in properties)
            {
                property.ReadOnly = true;
                property.SourceEditable = false;
                ForceExpandableReadOnly(property.Properties);
            }
        }

        private static string JoinPropertyPath(string parent, string child) =>
            string.IsNullOrEmpty(parent) ? child : parent + "." + child;

        private static string BoundString(string value, int maxChars)
        {
            if (value.Length <= maxChars) return value;
            if (maxChars <= 17) return value.Substring(0, maxChars);
            return value.Substring(0, maxChars - 17) + "~" + StableHash64(value).ToString("x16",
                System.Globalization.CultureInfo.InvariantCulture);
        }

        private static string? BoundNullable(string? value, int maxChars) =>
            value == null ? null : BoundString(value, maxChars);

        private static ulong StableHash64(string value)
        {
            const ulong offset = 14695981039346656037UL;
            const ulong prime = 1099511628211UL;
            ulong hash = offset;
            foreach (char character in value) { hash ^= character; hash *= prime; }
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

        private sealed class ExpandableDescribeContext : ITypeDescriptorContext
        {
            private readonly object _instance;
            private readonly PropertyDescriptor _descriptor;
            public ExpandableDescribeContext(object instance, PropertyDescriptor descriptor)
            { _instance = instance; _descriptor = descriptor; }
            public IContainer? Container { get { try { return (_instance as IComponent)?.Site?.Container; } catch { return null; } } }
            public object? Instance => _instance;
            public PropertyDescriptor? PropertyDescriptor => _descriptor;
            public object? GetService(Type serviceType)
            { try { return (_instance as IComponent)?.Site?.GetService(serviceType); } catch { return null; } }
            public bool OnComponentChanging() => true;
            public void OnComponentChanged() { }
        }

        /// <summary>Reverse the component→field-name map to find the live component a designer field id names — the
        /// path DescribeOn takes for a non-Control field (a ToolStripItem). Reads FieldNames directly (kept pruned by
        /// every remove path + populated by every live-add path) so there is no parallel map to fall out of sync; the
        /// scan is O(field count) and only runs on the ByField miss (never for a plain control). Field names are
        /// unique, so at most one entry matches.</summary>
        private static IComponent? ResolveComponentByFieldName(LiveDesign live, string fieldName)
        {
            IComponent? match = null;
            foreach (var kv in live.FieldNames)
            {
                if (kv.Value != fieldName || !(kv.Key is IComponent component)) continue;
                if (match != null && !ReferenceEquals(match, component)) return null;
                match = component;
            }
            return match;
        }

        /// <summary>Resolve a component id to its live instance for a per-property live edit / reset / describe: a
        /// control via ByField (the fast path), else a field-backed non-Control IComponent (a ToolStripItem) via the
        /// FieldNames reverse-scan. Root ("this"/"") → the form. Null when the id names nothing live. One resolver so
        /// describe and edit can never disagree about what an id points at.</summary>
        private IComponent? ResolveLiveTarget(LiveDesign live, string componentId)
        {
            if (componentId == "this" || componentId.Length == 0) return live.Root;
            if (live.AmbiguousIds != null && live.AmbiguousIds.Contains(componentId)) return null;
            return live.ByField.TryGetValue(componentId, out var c) ? c : ResolveComponentByFieldName(live, componentId);
        }

        private static string OwnershipOf(LiveDesign live, object target)
        {
            if (ReferenceEquals(target, live.Root)) return InheritedOwnershipPolicy.Root;
            return live.Ownership != null && live.Ownership.TryGetValue(target, out var ownership)
                ? ownership
                : InheritedOwnershipPolicy.Unresolved;
        }

        /// <summary>The server-authoritative visual-inheritance gate. UI metadata is only an affordance; every live
        /// edit route calls this policy so a direct RPC cannot mutate a base-declared or unproven identity.</summary>
        private bool TryResolveEditableTarget(LiveDesign live, string componentId, out IComponent? target, out string reason)
        {
            target = ResolveLiveTarget(live, componentId ?? "");
            if (target == null)
            {
                reason = "no component '" + componentId + "'";
                return false;
            }
            string ownership = OwnershipOf(live, target);
            if (!InheritedOwnershipPolicy.IsEditable(ownership))
            {
                reason = "cannot edit '" + componentId + "': " + InheritedOwnershipPolicy.ReadOnlyReason(ownership);
                return false;
            }
            reason = "";
            return true;
        }

        private bool TryResolveEditableControl(LiveDesign live, string componentId, out Control? control, out string reason)
        {
            if (!TryResolveEditableTarget(live, componentId, out var target, out reason) || !(target is Control value))
            {
                control = null;
                if (reason.Length == 0) reason = "no control '" + componentId + "'";
                return false;
            }
            control = value;
            return true;
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
            if (!TryResolveEditableTarget(live, componentId, out var target, out _)) return null;
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

        private static Dictionary<string, Control> BuildControlIndex(Dictionary<object, string> fieldNames,
            out HashSet<string> ambiguousIds)
        {
            var index = new Dictionary<string, Control>(StringComparer.Ordinal);
            ambiguousIds = new HashSet<string>(StringComparer.Ordinal);
            foreach (var kv in fieldNames)
            {
                if (!(kv.Key is Control control) || kv.Value.Length == 0) continue;
                if (ambiguousIds.Contains(kv.Value)) continue;
                if (index.TryGetValue(kv.Value, out var existing) && !ReferenceEquals(existing, control))
                {
                    index.Remove(kv.Value);
                    ambiguousIds.Add(kv.Value);
                }
                else index[kv.Value] = control;
            }
            return index;
        }

        /// <summary>Classify the same reflection identities as <see cref="BuildFieldNameMap"/> by the field's declaring
        /// type. The loops and first-instance-wins rule intentionally match that method exactly, including hidden-field
        /// collisions; an object whose identity cannot be tied to a field is absent and therefore unresolved.</summary>
        private static Dictionary<object, string> BuildOwnershipMap(object instance, Type designedType)
        {
            var map = new Dictionary<object, string>(ReferenceEqualityComparer.Instance);
            for (Type? t = designedType; t != null && t != typeof(object); t = t.BaseType)
            {
                foreach (var f in t.GetFields(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (!typeof(IComponent).IsAssignableFrom(f.FieldType)) continue;
                    object? value;
                    try { value = f.GetValue(instance); } catch { continue; }
                    if (value != null && !map.ContainsKey(value))
                        map[value] = InheritedOwnershipPolicy.FromDeclaration(designedType, f.DeclaringType);
                }
            }
            return map;
        }

        private static List<LayoutControl> BuildLayoutControls(LiveDesign live, string rootClassName, int frameW, int frameH)
        {
            Control root = live.Root;
            Dictionary<object, string> fieldNames = live.FieldNames;
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
                string ownership = !isRoot && live.AmbiguousIds.Contains(id)
                    ? InheritedOwnershipPolicy.Unresolved
                    : OwnershipOf(live, ctrl);
                list.Add(new LayoutControl
                {
                    Id = id,
                    Name = isRoot ? rootClassName : id,
                    Type = ctrl.GetType().FullName ?? ctrl.GetType().Name,
                    ParentId = parentId,
                    IsRoot = isRoot,
                    Ownership = ownership,
                    Editable = InheritedOwnershipPolicy.IsEditable(ownership),
                    ReadOnlyReason = InheritedOwnershipPolicy.ReadOnlyReason(ownership),
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
            StampToolStripOwnership(items, live);
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

        private static void StampToolStripOwnership(IEnumerable<ToolStripItemBounds> bounds, LiveDesign live)
        {
            foreach (var bound in bounds)
            {
                object? target = null;
                if (!string.IsNullOrEmpty(bound.ItemId)) target = ResolveComponentByFieldName(live, bound.ItemId);
                else if (bound.OwnerId == "this" || bound.OwnerId.Length == 0) target = live.Root;
                else if (live.ByField.TryGetValue(bound.OwnerId, out var owner)) target = owner;

                string ownership = target == null ? InheritedOwnershipPolicy.Unresolved : OwnershipOf(live, target);
                bound.Ownership = ownership;
                bound.Editable = InheritedOwnershipPolicy.IsEditable(ownership);
                bound.ReadOnlyReason = InheritedOwnershipPolicy.ReadOnlyReason(ownership);
                if (bound.Children != null && bound.Children.Count > 0) StampToolStripOwnership(bound.Children, live);
            }
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
            // RightToLeftLayout mirrors the Form's client DC while leaving serialized Control.Left values logical.
            // Return painted/window coordinates so the webview overlays and hit testing line up with DrawToBitmap.
            if (root is Form form && form.RightToLeft == RightToLeft.Yes && form.RightToLeftLayout)
                x = root.ClientSize.Width - x - ctrl.Width;
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
                string ownership = live.FieldNames.Count(pair => pair.Value == kv.Value) > 1
                    ? InheritedOwnershipPolicy.Unresolved
                    : OwnershipOf(live, kv.Key);
                tray.Add(new TrayComponent
                {
                    Id = kv.Value,
                    Name = kv.Value,
                    Type = kv.Key.GetType().FullName ?? kv.Key.GetType().Name,
                    Ownership = ownership,
                    Editable = InheritedOwnershipPolicy.IsEditable(ownership),
                    ReadOnlyReason = InheritedOwnershipPolicy.ReadOnlyReason(ownership),
                    IconPng = ToolboxIconPng(kv.Key.GetType()),
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
            StampToolStripOwnership(forest, live);
            return forest;
        }

        private sealed class ReferenceEqualityComparer : IEqualityComparer<object>
        {
            public static readonly ReferenceEqualityComparer Instance = new ReferenceEqualityComparer();
            public new bool Equals(object x, object y) => ReferenceEquals(x, y);
            public int GetHashCode(object obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
        }
    }

    /// <summary>Neither render path could produce a picture: the source did not interpret AND the user's compiled form
    /// could not be constructed. Its own type so the outer handler can re-throw it untouched instead of wrapping the
    /// same sentence around itself.</summary>
    [Serializable]
    public sealed class BothRenderPathsFailedException : InvalidOperationException
    {
        public BothRenderPathsFailedException(string message, Exception inner) : base(message, inner) { }
        private BothRenderPathsFailedException(System.Runtime.Serialization.SerializationInfo info,
            System.Runtime.Serialization.StreamingContext context) : base(info, context) { }
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
            // NOTE: this thread does NOT choose its desktop — a thread inherits the PROCESS's, and an STA thread
            // cannot switch (COM's hidden window makes SetThreadDesktop refuse with ERROR_BUSY; measured). The whole
            // process is placed on the private render desktop at startup instead — see RenderDesktop.
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            // Never let WinForms answer an exception with its modal ThreadExceptionDialog. A vendor control that
            // throws inside a WndProc while we pump would otherwise open "Unhandled exception has occurred in your
            // application" — a MODAL window, so on the render desktop it would block this thread invisibly and wedge
            // the engine. Letting the exception travel instead surfaces it as a render failure the host can report.
            try { Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException); } catch { /* already set */ }
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
