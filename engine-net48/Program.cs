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

            if (Has(args, "--setprop", out string? sdesigner) && sdesigner != null)
            {
                return SetPropCli(args, sdesigner);
            }

            if (Has(args, "--remove", out string? rdesigner) && rdesigner != null)
            {
                string? rasm = Value(args, "--asm");
                string? rid = Value(args, "--id");
                if (rasm == null || rid == null) { Console.Error.WriteLine("--asm and --id required"); return 5; }
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
                if (aasm == null || ctype == null) { Console.Error.WriteLine("--asm and --ctype required"); return 5; }
                var aprobes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
                var api3 = new EngineApi();
                var pre = api3.RenderCompiledWithLayout(adesigner, aasm, null, aprobes, 0, 0);
                var post = api3.AddCompiledControl(adesigner, aasm, parent, ctype, newid, 20, 20, null, aprobes);
                bool present = post.Controls.Any(c => c.Id == newid);
                Console.WriteLine($"[add] '{ctype}' → '{newid}' in '{parent}': controls {pre.Controls.Count} -> {post.Controls.Count}; present={present}; applied={post.Applied}{(post.Diagnostics.Length > 0 ? " diag=" + post.Diagnostics : "")}");
                return present ? 0 : 4;
            }

            Console.WriteLine("usage: Engine.Net48 --pipe <name>");
            Console.WriteLine("       Engine.Net48 --render   <designerFile> --asm <assemblyPath> [--type T] [--out png] [--probe dir]...");
            Console.WriteLine("       Engine.Net48 --describe <designerFile> --asm <assemblyPath> --id <componentId|this> [--type T] [--probe dir]...");
            return 2;
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
                Console.WriteLine($"[describe] id={d.Id} type={d.Type} isRoot={d.IsRoot} parent={d.Parent} props={d.Properties.Count} events={d.Events.Count}");
                foreach (var p in d.Properties.Take(24))
                    Console.WriteLine($"   {p.Name} : {p.Type} = {p.Value ?? "(null)"}{(p.StandardValues != null ? $"  [{p.StandardValues.Count} std]" : "")}{(p.IsImage ? "  [image]" : "")}");
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
            return worker.DescribeComponent(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId);
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
