using System;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using Newtonsoft.Json.Serialization;
using StreamJsonRpc;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Second engine host (.NET Framework 4.8) for rendering Framework + DevExpress(PGMUI) controls the net9
    /// engine can't load. Same JSON-RPC-over-named-pipe contract as the net9 engine (StreamJsonRpc +
    /// HeaderDelimited + camelCase Newtonsoft), so the VS Code host routes to it transparently for net4x
    /// projects. Also a --render CLI for headless verification through the full engine path.
    /// </summary>
    internal static class Program
    {
        private static async Task<int> Main(string[] args)
        {
            if (Has(args, "--pipe", out string? pipeName) && pipeName != null)
            {
                await Console.Error.WriteLineAsync("[engine-net48] listening on pipe: " + pipeName);
                using (var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous))
                {
                    await pipe.WaitForConnectionAsync();
                    await Console.Error.WriteLineAsync("[engine-net48] client connected");
                    var formatter = new JsonMessageFormatter();
                    formatter.JsonSerializer.ContractResolver = new CamelCasePropertyNamesContractResolver();
                    var handler = new HeaderDelimitedMessageHandler(pipe, pipe, formatter);
                    var rpc = new JsonRpc(handler, new EngineApi());
                    rpc.StartListening();
                    await rpc.Completion;
                    await Console.Error.WriteLineAsync("[engine-net48] rpc completed");
                    return 0;
                }
            }

            if (Has(args, "--render", out string? designer) && designer != null)
            {
                return RenderCli(args, designer);
            }

            if (Has(args, "--describe", out string? ddesigner) && ddesigner != null)
            {
                return DescribeCli(args, ddesigner);
            }

            if (Has(args, "--list-toolbox", out _))
            {
                return ListToolboxCli(args);
            }

            if (Has(args, "--parse-meta", out string? pmFile) && pmFile != null)
            {
                // pure-text (no assembly): print the source-only facts SourceMetadata recovers for a component id.
                if (!File.Exists(pmFile)) { await Console.Error.WriteLineAsync("--parse-meta: file not found: " + pmFile); return 5; }
                string pmId = Value(args, "--id") ?? "this";
                var (props, handlers) = SourceMetadata.Dump(pmFile, pmId);
                Console.WriteLine($"[parse-meta] id={pmId}: {props.Count} explicit prop(s), {handlers.Count} wired event(s)");
                foreach (var p in props) Console.WriteLine("   * " + p);
                foreach (var h in handlers) Console.WriteLine($"   [event] {h.Key} -> {h.Value}");
                return 0;
            }

            if (Has(args, "--setprop", out string? sdesigner) && sdesigner != null)
            {
                return SetPropCli(args, sdesigner);
            }

            if (Has(args, "--remove", out string? rdesigner) && rdesigner != null)
            {
                string? rasm = Value(args, "--asm");
                string? rid = Value(args, "--id");
                if (rasm == null || rid == null) { await Console.Error.WriteLineAsync("--asm and --id required"); return 5; }
                var rprobes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
                var api2 = new EngineApi();
                var pre = api2.RenderCompiledWithLayout(rdesigner, rasm, null, rprobes, 0, 0);
                var post = api2.RemoveCompiledControls(rdesigner, rasm, new[] { rid }, null, rprobes);
                bool gone = !post.Controls.Any(c => c.Id == rid);
                Console.WriteLine($"[remove] '{rid}': controls {pre.Controls.Count} -> {post.Controls.Count}; gone={gone}; applied={post.Applied}{(post.Diagnostics.Length > 0 ? " diag=" + post.Diagnostics : "")}");
                return gone ? 0 : 4;
            }

            if (Has(args, "--add", out string? adesigner) && adesigner != null)
            {
                string? aasm = Value(args, "--asm");
                string parent = Value(args, "--parent") ?? "this";
                string? ctype = Value(args, "--ctype");
                string newid = Value(args, "--newid") ?? "newControl1";
                if (aasm == null || ctype == null) { await Console.Error.WriteLineAsync("--asm and --ctype required"); return 5; }
                var aprobes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
                var api3 = new EngineApi();
                var pre = api3.RenderCompiledWithLayout(adesigner, aasm, null, aprobes, 0, 0);
                var post = api3.AddCompiledControl(adesigner, aasm, parent, ctype, newid, 20, 20, null, aprobes);
                bool present = post.Controls.Any(c => c.Id == newid);
                Console.WriteLine($"[add] '{ctype}' → '{newid}' in '{parent}': controls {pre.Controls.Count} -> {post.Controls.Count}; present={present}; applied={post.Applied}{(post.Diagnostics.Length > 0 ? " diag=" + post.Diagnostics : "")}");
                return present ? 0 : 4;
            }

            if (Has(args, "--seltab", out string? tdesigner) && tdesigner != null)
            {
                string? tasm = Value(args, "--asm");
                string thost = Value(args, "--host") ?? "this";
                int tx = int.TryParse(Value(args, "--x"), out var xv) ? xv : 0;
                int ty = int.TryParse(Value(args, "--y"), out var yv) ? yv : 0;
                if (tasm == null) { await Console.Error.WriteLineAsync("--asm required"); return 5; }
                var tprobes = args.Select((a, i) => (a, i)).Where(z => z.a == "--probe").Select(z => args[z.i + 1]).ToArray();
                var api4 = new EngineApi();
                var pre = api4.RenderCompiledWithLayout(tdesigner, tasm, null, tprobes, 0, 0);
                var post = api4.SelectCompiledTabAt(tdesigner, tasm, thost, tx, ty, null, tprobes);
                Console.WriteLine($"[seltab] host='{thost}' @({tx},{ty}): controls {pre.Controls.Count} -> {post.Controls.Count}; switched={post.Applied}");
                foreach (var c in post.Controls.Take(16))
                    Console.WriteLine($"   id={c.Id} @({c.X},{c.Y}) {c.Width}x{c.Height} parent={c.ParentId} tabHost={c.IsTabHost}");
                return post.Applied ? 0 : 4;
            }

            if (Has(args, "--hittab", out string? hdesigner) && hdesigner != null)
            {
                string? hasm = Value(args, "--asm");
                string hhost = Value(args, "--host") ?? "this";
                int hx = int.TryParse(Value(args, "--x"), out var hxv) ? hxv : 0;
                int hy = int.TryParse(Value(args, "--y"), out var hyv) ? hyv : 0;
                if (hasm == null) { await Console.Error.WriteLineAsync("--asm required"); return 5; }
                var hprobes = args.Select((a, i) => (a, i)).Where(z => z.a == "--probe").Select(z => args[z.i + 1]).ToArray();
                var api5 = new EngineApi();
                api5.RenderCompiledWithLayout(hdesigner, hasm, null, hprobes, 0, 0);
                var th = api5.HitTestCompiledTab(hdesigner, hasm, hhost, hx, hy, null, hprobes);
                Console.WriteLine($"[hittab] host='{hhost}' @({hx},{hy}): pageId='{th.PageId}' text='{th.Text}'");
                return string.IsNullOrEmpty(th.PageId) ? 4 : 0;
            }

            if (Has(args, "--addtab", out string? atdesigner) && atdesigner != null)
            {
                string? atasm = Value(args, "--asm");
                string athost = Value(args, "--host") ?? "this";
                string? atpage = Value(args, "--pagetype");
                string atid = Value(args, "--newid") ?? "newTabPage1";
                if (atasm == null || atpage == null) { await Console.Error.WriteLineAsync("--asm and --pagetype required"); return 5; }
                var atprobes = args.Select((a, i) => (a, i)).Where(z => z.a == "--probe").Select(z => args[z.i + 1]).ToArray();
                var api6 = new EngineApi();
                var pre = api6.RenderCompiledWithLayout(atdesigner, atasm, null, atprobes, 0, 0);
                var post = api6.AddCompiledTab(atdesigner, atasm, athost, atpage, atid, null, atprobes);
                bool present = post.Controls.Any(c => c.Id == atid);
                Console.WriteLine($"[addtab] '{atpage}' → '{atid}' in '{athost}': controls {pre.Controls.Count} -> {post.Controls.Count}; present={present}; applied={post.Applied}{(post.Diagnostics.Length > 0 ? " diag=" + post.Diagnostics : "")}");
                return present ? 0 : 4;
            }

            if (Has(args, "--deltab", out string? dtdesigner) && dtdesigner != null)
            {
                string? dtasm = Value(args, "--asm");
                string dthost = Value(args, "--host") ?? "this";
                string? dtpage = Value(args, "--page");
                if (dtasm == null || dtpage == null) { await Console.Error.WriteLineAsync("--asm and --page required"); return 5; }
                var dtprobes = args.Select((a, i) => (a, i)).Where(z => z.a == "--probe").Select(z => args[z.i + 1]).ToArray();
                var api7 = new EngineApi();
                var pre = api7.RenderCompiledWithLayout(dtdesigner, dtasm, null, dtprobes, 0, 0);
                var post = api7.RemoveCompiledTab(dtdesigner, dtasm, dthost, dtpage, null, dtprobes);
                bool gone = !post.Controls.Any(c => c.Id == dtpage);
                Console.WriteLine($"[deltab] '{dtpage}' from '{dthost}': controls {pre.Controls.Count} -> {post.Controls.Count}; gone={gone}; applied={post.Applied}{(post.Diagnostics.Length > 0 ? " diag=" + post.Diagnostics : "")}");
                return gone && post.Applied ? 0 : 4;
            }

            Console.WriteLine("usage: Engine.Net48 --pipe <name>");
            Console.WriteLine("       Engine.Net48 --render   <designerFile> --asm <assemblyPath> [--type T] [--out png] [--probe dir]...");
            Console.WriteLine("       Engine.Net48 --describe <designerFile> --asm <assemblyPath> --id <componentId|this> [--type T] [--probe dir]...");
            Console.WriteLine("       Engine.Net48 --list-toolbox --asm <assemblyPath> [--probe dir]...   (project/vendor controls the net9 enumerator can't load)");
            return 2;
        }

        /// <summary>Headless self-test for the DevExpress-add toolbox: list the compiled assembly's own toolbox-eligible
        /// controls (the ones the net9 enumerator can't load) — the net48 "Project Controls" the host merges into the palette.</summary>
        private static int ListToolboxCli(string[] args)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
            var api = new EngineApi();
            try
            {
                var items = api.ListCompiledToolboxControls(asm, probes);
                Console.WriteLine($"[toolbox] {items.Length} project control(s) from {Path.GetFileName(asm)}");
                foreach (var it in items.Take(80))
                    Console.WriteLine($"   {(it.IconPng != null ? "[icon]" : "      ")} {it.Name}  ({it.Fqn})");
                return 0;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[toolbox] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

        /// <summary>Headless self-test: exercises DomainManager + child AppDomain + RenderWorker end to end.</summary>
        private static int RenderCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string? type = Value(args, "--type");
            string? outPng = Value(args, "--out");
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();

            var api = new EngineApi();
            try
            {
                var r = api.RenderCompiledWithLayout(designer, asm, type, probes, 0, 0);
                Console.WriteLine($"[render] rootType={r.RootType} size={r.Width}x{r.Height} controls={r.Controls.Count} tray={r.Tray.Count} png={r.Png.Length}B");
                foreach (var c in r.Controls.Take(12))
                    Console.WriteLine($"   {(c.IsRoot ? "*" : " ")} id={c.Id} type={c.Type} @({c.X},{c.Y}) {c.Width}x{c.Height} d{c.Depth} parent={c.ParentId}");
                if (!string.IsNullOrEmpty(r.Diagnostics)) Console.WriteLine("[render] diag: " + r.Diagnostics);
                if (!string.IsNullOrEmpty(outPng)) { File.WriteAllBytes(outPng!, r.Png); Console.WriteLine("[render] wrote " + Path.GetFullPath(outPng!)); }
                return r.Png.Length > 0 ? 0 : 2;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[render] {e.GetType().FullName}: {e.Message}");
                return ex.GetBaseException() is System.ComponentModel.LicenseException ? 3 : 4;
            }
        }

        /// <summary>Headless self-test for the property panel: describe one control of the live compiled instance.</summary>
        private static int DescribeCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string id = Value(args, "--id") ?? "this";
            string? type = Value(args, "--type");
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();

            var api = new EngineApi();
            try
            {
                var d = api.DescribeCompiledComponent(designer, asm, id, type, probes);
                if (d == null) { Console.Error.WriteLine("[describe] no field-backed control with id '" + id + "'"); return 4; }
                int explicitCount = d.Properties.Count(p => p.SourceExplicit);
                int wiredCount = d.Events.Count(e => e.Handler != null);
                Console.WriteLine($"[describe] id={d.Id} type={d.Type} isRoot={d.IsRoot} parent={d.Parent} props={d.Properties.Count} ({explicitCount} explicit) events={d.Events.Count} ({wiredCount} wired)");
                foreach (var p in d.Properties.Take(24))
                    Console.WriteLine($"   {(p.SourceExplicit ? "*" : " ")} {p.Name} : {p.Type} = {p.Value ?? "(null)"}{(p.StandardValues != null ? $"  [{p.StandardValues.Count} std]" : "")}{(p.IsImage ? "  [image]" : "")}");
                foreach (var e in d.Events.Where(e => e.Handler != null).Take(12))
                    Console.WriteLine($"   [event] {e.Name} -> {e.Handler}");
                return 0;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[describe] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

        /// <summary>Headless self-test for the live property edit: mutate one property + report the new render.</summary>
        private static int SetPropCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string id = Value(args, "--id") ?? "this";
            string? prop = Value(args, "--prop");
            string? val = Value(args, "--value");
            if (prop == null || val == null) { Console.Error.WriteLine("--prop <name> --value <invariant> required"); return 5; }
            string? outPng = Value(args, "--out");
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();

            var api = new EngineApi();
            try
            {
                var r = api.SetCompiledPropertyLive(designer, asm, id, prop, val, null, probes);
                Console.WriteLine($"[setprop] applied={r.Applied} size={r.Width}x{r.Height} png={r.Png.Length}B{(r.Diagnostics.Length > 0 ? " diag=" + r.Diagnostics : "")}");
                if (!string.IsNullOrEmpty(outPng)) { File.WriteAllBytes(outPng!, r.Png); Console.WriteLine("[setprop] wrote " + Path.GetFullPath(outPng!)); }
                return r.Applied ? 0 : 2;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[setprop] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

        private static bool Has(string[] args, string flag, out string? value)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == flag) { value = i + 1 < args.Length ? args[i + 1] : null; return true; }
            }
            value = null;
            return false;
        }

        private static string? Value(string[] args, string flag)
        {
            for (int i = 0; i < args.Length - 1; i++) if (args[i] == flag) return args[i + 1];
            return null;
        }
    }

    /// <summary>JSON-RPC surface. Render-first (M1): render/layout are implemented; edit RPCs report unsupported
    /// via <see cref="GetCapabilities"/> so the host disables edit affordances and shows a "compiled preview" badge.</summary>
    public sealed class EngineApi
    {
        private readonly DomainManager _domains = new DomainManager();

        public string Ping() => "winforms-engine-net48 ok / " + RuntimeInformation.FrameworkDescription;

        public EngineCapabilities GetCapabilities() => new EngineCapabilities
        {
            Engine = "net48-compiled",
            Render = true,
            Edit = true, // property-grid edits (live instance mutation + net9 text splice); drag/add/remove are coming
            LivePreviewUnsavedEdits = false, // manual .Designer.cs edits reflect after a rebuild (compiled render)
            Runtime = RuntimeInformation.FrameworkDescription,
            Notes = "Renders the compiled control; property edits are live; manual source edits appear after a rebuild.",
        };

        /// <summary>Render the compiled control + hit-test map. assemblyPath is the design-host project's build
        /// output (the host resolves it); rootTypeName is optional (derived from the designer file when blank);
        /// probeDirs are fallback assembly-probe locations (target bin + vendor dirs).</summary>
        public RenderLayoutResult RenderCompiledWithLayout(string designerFilePath, string assemblyPath,
            string? rootTypeName = null, string[]? probeDirs = null, int width = 0, int height = 0)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.RenderWithLayout(assemblyPath, typeName, width, height);
        }

        /// <summary>Property-grid + events for one control of the LIVE compiled instance ("this" = root, else its
        /// .Designer.cs field name) — the read side behind the property panel in compiled-preview mode.</summary>
        public ComponentDesc? DescribeCompiledComponent(string designerFilePath, string assemblyPath, string componentId,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            var desc = worker.DescribeComponent(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId);
            // enrich with source-only facts the live TypeDescriptor can't see (Roslyn in the HOST domain): which
            // properties were assigned in source (grid bold) + which event handlers were wired (Events tab).
            SourceMetadata.Apply(desc, designerFilePath);
            return desc;
        }

        /// <summary>Enumerate the project/vendor (DevExpress/net4x) assembly's own toolbox-eligible controls — the
        /// net48 counterpart of the net9 engine's project-control enumeration, for the assemblies the net9 enumerator
        /// can't load. The host merges these (category "Project Controls") with the net9 framework palette so a net48
        /// form's toolbox offers the vendor controls. Reflection only, in the child domain; [] on a bad path.</summary>
        public ToolboxItemInfo[] ListCompiledToolboxControls(string assemblyPath, string[]? probeDirs = null)
        {
            if (string.IsNullOrWhiteSpace(assemblyPath) || !File.Exists(assemblyPath)) return Array.Empty<ToolboxItemInfo>();
            // Guard GetWorker (child-domain creation) too, so the whole call honors the "[] on any failure" contract
            // (the worker method is already fully guarded); the host degrades to a framework-only toolbox.
            try
            {
                var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
                return worker.ListToolboxControls(assemblyPath);
            }
            catch { return Array.Empty<ToolboxItemInfo>(); }
        }

        /// <summary>Apply one property edit to the live compiled instance + re-render (live preview for a
        /// designer-originated edit). The persisted text write is the host's job (net9 splice); this returns the
        /// fresh picture + layout, with Applied=false + a reason when the value couldn't be applied live.</summary>
        public RenderLayoutResult SetCompiledPropertyLive(string designerFilePath, string assemblyPath, string componentId,
            string propName, string rawValue, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.SetPropertyLive(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId, propName, rawValue ?? "");
        }

        /// <summary>Apply a BATCH of property edits to the live instance + re-render once (drag/resize/align).</summary>
        public RenderLayoutResult ApplyCompiledEdits(string designerFilePath, string assemblyPath, PropEdit[] edits,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.ApplyEdits(assemblyPath, typeName, edits ?? Array.Empty<PropEdit>());
        }

        /// <summary>Remove field-backed controls from the live instance + re-render.</summary>
        public RenderLayoutResult RemoveCompiledControls(string designerFilePath, string assemblyPath, string[] ids,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.RemoveControls(assemblyPath, typeName, ids ?? Array.Empty<string>());
        }

        /// <summary>Bring-to-front / send-to-back the given field-backed controls of the live instance + re-render.</summary>
        public RenderLayoutResult SetCompiledZOrder(string designerFilePath, string assemblyPath, string[] ids, bool toFront,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.SetZOrder(assemblyPath, typeName, ids ?? Array.Empty<string>(), toFront);
        }

        /// <summary>Add a control of controlTypeKey to parentId at (locX,locY), registered under newId, on the live
        /// instance + re-render (the persisted declaration is the host's net9 splice).</summary>
        public RenderLayoutResult AddCompiledControl(string designerFilePath, string assemblyPath, string parentId,
            string controlTypeKey, string newId, int locX = -1, int locY = -1, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.AddControl(assemblyPath, typeName, parentId ?? "this", controlTypeKey ?? "", newId ?? "", locX, locY);
        }

        /// <summary>Switch the active tab of the tab host at hostId to the header under window-space (x,y) +
        /// re-render (Applied=true only when the active tab actually changed).</summary>
        public RenderLayoutResult SelectCompiledTabAt(string designerFilePath, string assemblyPath, string hostId, int x, int y,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.SelectTabAt(assemblyPath, typeName, hostId ?? "this", x, y);
        }

        /// <summary>Return the tab page (field id + Text) whose header is under window-space (x,y) on the tab host —
        /// used to rename a tab (the host then edits that page's Text via the normal edit path).</summary>
        public TabHit HitTestCompiledTab(string designerFilePath, string assemblyPath, string hostId, int x, int y,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.HitTestTab(assemblyPath, typeName, hostId ?? "this", x, y);
        }

        /// <summary>Add a new empty tab page (type pageTypeFqn) to the tab host on the live instance + re-render (the
        /// persisted field/statements are the host's net9 splice).</summary>
        public RenderLayoutResult AddCompiledTab(string designerFilePath, string assemblyPath, string hostId, string pageTypeFqn, string newId,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.AddTab(assemblyPath, typeName, hostId ?? "this", pageTypeFqn ?? "", newId ?? "");
        }

        /// <summary>Remove tab page pageId from the tab host on the live instance + re-render (Applied=true when the
        /// page was a live child). The persisted removal is the host's net9 text edit.</summary>
        public RenderLayoutResult RemoveCompiledTab(string designerFilePath, string assemblyPath, string hostId, string pageId,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.RemoveTab(assemblyPath, typeName, hostId ?? "this", pageId ?? "");
        }

        private static string ResolveTypeName(string designerFilePath, string assemblyPath, string? rootTypeName)
        {
            if (string.IsNullOrWhiteSpace(assemblyPath) || !File.Exists(assemblyPath))
                throw new FileNotFoundException("control assembly not found", assemblyPath);
            string typeName = string.IsNullOrWhiteSpace(rootTypeName) ? RootTypeResolver.Resolve(designerFilePath) : rootTypeName!;
            if (string.IsNullOrEmpty(typeName))
                throw new InvalidOperationException("could not determine the root control type from " + designerFilePath);
            return typeName;
        }

        private static string[] ComputeProbes(string assemblyPath, string[]? probeDirs)
        {
            string binDir = Path.GetDirectoryName(Path.GetFullPath(assemblyPath))!;
            return (probeDirs ?? Array.Empty<string>())
                .Concat(new[] { binDir, @"C:\Program Files (x86)\PGMUI 1.2\Components\Bin\Framework" })
                .Where(Directory.Exists)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
    }
}
