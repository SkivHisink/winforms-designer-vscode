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
    /// Second engine host (.NET Framework 4.8) for rendering Framework + DevExpress controls the net9
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

            if (Has(args, "--render-interpreted", out string? idesigner) && idesigner != null)
            {
                return RenderInterpretedCli(args, idesigner);
            }

            if (Has(args, "--compare", out string? cmpdesigner) && cmpdesigner != null)
            {
                return CompareCli(args, cmpdesigner);
            }

            if (Has(args, "--describe-interpreted", out string? didesigner) && didesigner != null)
            {
                return DescribeInterpretedCli(args, didesigner);
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

            if (Has(args, "--setcoll", out string? scdesigner) && scdesigner != null)
            {
                return SetCollCli(args, scdesigner);
            }

            if (Has(args, "--setnodes", out string? sndesigner) && sndesigner != null)
            {
                return SetNodesCli(args, sndesigner);
            }

            if (Has(args, "--settsitems", out string? tsdesigner) && tsdesigner != null)
            {
                return SetToolStripItemsLiveCli(args, tsdesigner);
            }

            if (Has(args, "--setlines", out string? sldesigner) && sldesigner != null)
            {
                return SetLinesCli(args, sldesigner);
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

            if (Has(args, "--il-serialize", out _))
            {
                return ImageListSerializeCli(args);
            }

            Console.WriteLine("usage: Engine.Net48 --pipe <name>");
            Console.WriteLine("       Engine.Net48 --render   <designerFile> --asm <assemblyPath> [--type T] [--out png] [--probe dir]...");
            Console.WriteLine("       Engine.Net48 --describe <designerFile> --asm <assemblyPath> --id <componentId|this> [--type T] [--probe dir]...");
            Console.WriteLine("       Engine.Net48 --list-toolbox --asm <assemblyPath> [--probe dir]...   (project/vendor controls the net9 enumerator can't load)");
            Console.WriteLine("       Engine.Net48 --il-serialize --img <file> [--img <file>]... [--width N] [--height N] [--depth Depth32Bit] [--transparent Transparent]   (ImageList ImageStream blob)");
            return 2;
        }

        /// <summary>0.11.0 headless self-test for the ImageList serialize primitive: build an ImageStream blob from the
        /// given image files (keys = file names) and report the payload length + self round-trip count. No assembly.</summary>
        private static int ImageListSerializeCli(string[] args)
        {
            var imgs = args.Select((a, i) => (a, i)).Where(x => x.a == "--img").Select(x => args[x.i + 1]).ToArray();
            if (imgs.Length == 0) { Console.Error.WriteLine("--img <file> required (repeatable)"); return 5; }
            int w = int.TryParse(Value(args, "--width"), out var pw) ? pw : 16;
            int h = int.TryParse(Value(args, "--height"), out var ph) ? ph : 16;
            var spec = new ImageListSpec
            {
                Width = w,
                Height = h,
                ColorDepth = Value(args, "--depth") ?? "",
                TransparentColor = Value(args, "--transparent") ?? "",
                Images = imgs.Select(p => new ImageListImage
                {
                    DataBase64 = Convert.ToBase64String(File.ReadAllBytes(p)),
                    Key = Path.GetFileNameWithoutExtension(p),
                }).ToArray(),
            };
            var res = ImageListSerializer.Serialize(spec);
            Console.WriteLine("== engine-net48 ImageList serialize");
            Console.WriteLine("   ok        : " + res.Ok + (res.Ok ? "" : " | reason: " + res.Reason));
            Console.WriteLine("   base64    : " + res.Base64.Length + " chars");
            Console.WriteLine("   mimetype  : " + res.MimeType);
            Console.WriteLine("   keys      : " + string.Join(",", res.Keys));
            Console.WriteLine("   roundtrip : " + res.Count + " image(s)");
            string? outFile = Value(args, "--out");
            if (outFile != null && res.Ok) { File.WriteAllText(outFile, res.Base64); Console.WriteLine("   wrote blob: " + outFile); }
            Console.WriteLine(res.Ok && res.Count == imgs.Length ? "RESULT: PASS" : "RESULT: FAIL");
            return res.Ok && res.Count == imgs.Length ? 0 : 4;
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
                Console.WriteLine($"[render] rootType={r.RootType} size={r.Width}x{r.Height} controls={r.Controls.Count} tray={r.Tray.Count} stripItems={r.ToolStripItems.Count} png={r.Png.Length}B");
                foreach (var c in r.Controls.Take(12))
                    Console.WriteLine($"   {(c.IsRoot ? "*" : " ")} id={c.Id} type={c.Type} @({c.X},{c.Y}) {c.Width}x{c.Height} d{c.Depth} parent={c.ParentId}{(c.IsStripHost ? " [strip-host]" : "")}");
                foreach (var it in r.ToolStripItems)
                    Console.WriteLine($"   · {it.OwnerId} ▸ {(it.IsTypeHere ? "[Type Here]" : it.ItemId + " : " + it.ItemType + (string.IsNullOrEmpty(it.Text) ? "" : " '" + it.Text + "'"))} @({it.X},{it.Y}) {it.Width}x{it.Height}");
                foreach (var t in r.Tray)
                    Console.WriteLine($"   [tray] {t.Name} [id={t.Id}] : {t.Type}");
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

        /// <summary>Headless self-test for the INTERPRETED render: parse the live .Designer.cs source,
        /// interpret it onto the compiled base type (VS model), and report the mode + control set. Falls back to the
        /// compiled render with a named reason when the interpreter can't cover the form.</summary>
        private static int RenderInterpretedCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string? type = Value(args, "--type");
            string? outPng = Value(args, "--out");
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
            // transient tab overrides: --select-tab tabControl1=tabPage2 (repeatable).
            var selectedTabs = args.Select((a, i) => (a, i)).Where(x => x.a == "--select-tab").Select(x => args[x.i + 1]).ToArray();
            string src = File.Exists(designer) ? File.ReadAllText(designer) : "";

            var api = new EngineApi();
            try
            {
                var r = api.RenderInterpretedWithLayout(designer, asm, src, type, probes, 0, 0, selectedTabs);
                Console.WriteLine($"[render-interpreted] mode={r.RenderMode}" +
                    (string.IsNullOrEmpty(r.FallbackReason) ? "" : " fallback=" + r.FallbackReason) +
                    $" rootType={r.RootType} size={r.Width}x{r.Height} controls={r.Controls.Count} tray={r.Tray.Count} png={r.Png.Length}B");
                foreach (var c in r.Controls.Take(12))
                    Console.WriteLine($"   {(c.IsRoot ? "*" : " ")} id={c.Id} type={c.Type} @({c.X},{c.Y}) {c.Width}x{c.Height} parent={c.ParentId}");
                if (!string.IsNullOrEmpty(r.Diagnostics)) Console.WriteLine("[render-interpreted] diag: " + r.Diagnostics);
                if (!string.IsNullOrEmpty(outPng)) { File.WriteAllBytes(outPng!, r.Png); Console.WriteLine("[render-interpreted] wrote " + Path.GetFullPath(outPng!)); }
                return r.Png.Length > 0 ? 0 : 2;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[render-interpreted] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

        /// <summary>Differential comparator — render a form BOTH ways (compiled last build + interpreted
        /// live source) and diff the field-backed control geometry. The interpreted render must reproduce the compiled
        /// truth: same id set, same rects (within a small tolerance). Reports EQUIVALENT / DIVERGENT with the deltas —
        /// the trust gate for the interpreter (an interpreter defect shows here as an unexplained geometry divergence).
        /// NOTE: a first cut renders both in the same worker sequentially; the release comparator isolates each leg in
        /// its own fresh AppDomain against hash-matched sources — a later step.</summary>
        private static int CompareCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string? type = Value(args, "--type");
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
            string src = File.Exists(designer) ? File.ReadAllText(designer) : "";

            var api = new EngineApi();
            var interp = api.RenderInterpretedWithLayout(designer, asm, src, type, probes, 0, 0);
            if (interp.RenderMode != "interpreted")
            {
                Console.WriteLine($"[compare] {Path.GetFileName(designer)}: interpreted FELL BACK ({interp.FallbackReason}) — nothing to compare, compiled is authoritative");
                return 0; // a disclosed fallback is a valid outcome, not a divergence
            }
            var compiled = api.RenderCompiledWithLayout(designer, asm, type, probes, 0, 0);

            var cmap = compiled.Controls.Where(c => !c.IsRoot).GroupBy(c => c.Id).ToDictionary(g => g.Key, g => g.First());
            var imap = interp.Controls.Where(c => !c.IsRoot).GroupBy(c => c.Id).ToDictionary(g => g.Key, g => g.First());
            var onlyC = cmap.Keys.Where(k => !imap.ContainsKey(k)).ToList();
            var onlyI = imap.Keys.Where(k => !cmap.ContainsKey(k)).ToList();
            int mismatched = 0;
            foreach (var id in cmap.Keys.Where(imap.ContainsKey))
            {
                var a = cmap[id]; var b = imap[id];
                if (Math.Abs(a.X - b.X) > 2 || Math.Abs(a.Y - b.Y) > 2 || Math.Abs(a.Width - b.Width) > 2 || Math.Abs(a.Height - b.Height) > 2)
                {
                    mismatched++;
                    Console.WriteLine($"   ≠ {id}: compiled ({a.X},{a.Y},{a.Width}x{a.Height}) vs interpreted ({b.X},{b.Y},{b.Width}x{b.Height})");
                }
            }
            foreach (var id in onlyC) Console.WriteLine($"   - only compiled: {id}");
            foreach (var id in onlyI) Console.WriteLine($"   + only interpreted: {id}");
            bool ok = onlyC.Count == 0 && onlyI.Count == 0 && mismatched == 0;
            Console.WriteLine($"[compare] {Path.GetFileName(designer)}: {(ok ? "EQUIVALENT" : "DIVERGENT")} — compiled={cmap.Count} interpreted={imap.Count} onlyC={onlyC.Count} onlyI={onlyI.Count} mismatched={mismatched}");
            return ok ? 0 : 4;
        }

        /// <summary>Headless self-test for the property panel: describe one control of the live compiled instance.</summary>
        /// <summary>headless self-test for INTERPRETED describe: describe one component of the live
        /// interpreted graph (identity model), proving the panel reads the live-source value, the logical root name, and
        /// current-source-only reference siblings. Returns 4 when the form doesn't interpret / the id isn't current.</summary>
        private static int DescribeInterpretedCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string id = Value(args, "--id") ?? "this";
            string? type = Value(args, "--type");
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
            string src = File.Exists(designer) ? File.ReadAllText(designer) : "";

            var api = new EngineApi();
            try
            {
                var d = api.DescribeInterpretedComponent(designer, asm, src, id, type, probes, 0, 0);
                if (d == null) { Console.Error.WriteLine("[describe-interpreted] not interpreted or no current component id '" + id + "'"); return 4; }
                int explicitCount = d.Properties.Count(p => p.SourceExplicit);
                Console.WriteLine($"[describe-interpreted] id={d.Id} type={d.Type} name={d.Name} isRoot={d.IsRoot} parent={d.Parent} props={d.Properties.Count} ({explicitCount} explicit) events={d.Events.Count}");
                foreach (var p in d.Properties.Take(24))
                    Console.WriteLine($"   {(p.SourceExplicit ? "*" : " ")} {p.Name} : {p.Type} = {p.Value ?? "(null)"}");
                foreach (var p in d.Properties.Where(p => p.StandardValues != null && p.StandardValues.Count > 0))
                    Console.WriteLine($"   [dropdown] {p.Name}{(p.StandardValuesExclusive ? " (exclusive)" : "")}: {string.Join(", ", p.StandardValues)}");
                return 0;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[describe-interpreted] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

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
                // properties offering a dropdown (TypeConverter standard values) — incl. ImageIndex/ImageKey when an
                // ImageList is attached, ReferenceConverter component picks, enum/bool/Cursor/Color sets, etc.
                foreach (var p in d.Properties.Where(p => p.StandardValues != null && p.StandardValues.Count > 0))
                    Console.WriteLine($"   [dropdown] {p.Name}{(p.StandardValuesExclusive ? " (exclusive)" : "")}: {string.Join(", ", p.StandardValues)}");
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

        /// <summary>Headless self-test for the live collection reconstruction (T1.1b): rebuild owner.propName from
        /// comma-separated --items (each token becomes one item's Text) + report the new render. Exercises the whole
        /// path (DomainManager → child AppDomain → STA → typed Clear/Add) for string Items and column header text.</summary>
        private static int SetCollCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string id = Value(args, "--id") ?? "this";
            string? prop = Value(args, "--prop");
            string itemType = Value(args, "--itemtype") ?? "System.String";
            string itemsCsv = Value(args, "--items") ?? "";
            if (prop == null) { Console.Error.WriteLine("--prop <name> required"); return 5; }
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
            var items = itemsCsv.Length == 0
                ? Array.Empty<LiveCollItem>()
                : itemsCsv.Split(',').Select(s => new LiveCollItem { Text = s }).ToArray();

            var api = new EngineApi();
            try
            {
                var r = api.SetCompiledCollectionLive(designer, asm, id, prop, itemType, items, null, probes);
                Console.WriteLine($"[setcoll] applied={r.Applied} type={itemType} items={items.Length} size={r.Width}x{r.Height} png={r.Png.Length}B{(r.Diagnostics.Length > 0 ? " diag=" + r.Diagnostics : "")}");
                return r.Applied ? 0 : 2;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[setcoll] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

        /// <summary>Headless self-test for the net48 live node picture: rebuild the TreeView owner.propName (Nodes) on
        /// the live compiled instance from <c>--nodes</c> and report the new render. The mini-syntax is a comma list of
        /// roots, each optionally "text&gt;child1;child2" (one child level, ';'-separated) so the recursion path is
        /// exercised — e.g. <c>--nodes "Fruits&gt;Apple;Banana,Vegetables&gt;Carrot"</c>. Drives the whole path
        /// (DomainManager → child AppDomain → STA → TreeNodeCollection Clear/recursive Add) + the LiveTreeNode DTO
        /// serialization across the domain boundary.</summary>
        private static int SetNodesCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string id = Value(args, "--id") ?? "this";
            string prop = Value(args, "--prop") ?? "Nodes";
            string nodesSpec = Value(args, "--nodes") ?? "";
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
            var nodes = ParseNodesSpec(nodesSpec);

            var api = new EngineApi();
            try
            {
                var r = api.SetCompiledTreeNodesLive(designer, asm, id, prop, nodes, null, probes);
                Console.WriteLine($"[setnodes] applied={r.Applied} roots={nodes.Length} size={r.Width}x{r.Height} png={r.Png.Length}B{(r.Diagnostics.Length > 0 ? " diag=" + r.Diagnostics : "")}");
                return r.Applied ? 0 : 2;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[setnodes] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

        /// <summary>Headless self-test for the net48 live ToolStrip/MenuStrip item picture: reconcile the strip owner's
        /// items on the live compiled instance from <c>--tsitem</c> and report the new render. Each <c>--tsitem</c> is a
        /// "depth|id|text|itemType" token (depth 0 = top-level, deeper = a DropDownItems child of the previous shallower
        /// item), so add (empty→minted id is the net9 job; here pass an id) / remove (omit an id) / rename (id + new
        /// text) / reorder (reordered ids) / nesting are all exercisable — e.g.
        /// <c>--tsitem "0|fileMenu|File|ToolStripMenuItem" --tsitem "1|openItem|Open|ToolStripMenuItem"</c>. Drives the
        /// whole path (DomainManager → child AppDomain → STA → surgical Items reconcile) + the LiveToolStripItem DTO
        /// serialization across the domain boundary.</summary>
        private static int SetToolStripItemsLiveCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string id = Value(args, "--id") ?? "this";
            var specs = args.Select((a, i) => (a, i)).Where(x => x.a == "--tsitem").Select(x => x.i + 1 < args.Length ? args[x.i + 1] : "").ToArray();
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
            var items = BuildToolStripForest(specs);

            var api = new EngineApi();
            try
            {
                var r = api.SetCompiledToolStripItemsLive(designer, asm, id, items, null, probes);
                // The tray lists every non-Control field component (incl. ToolStrip items) by field id, so it directly
                // reflects the reconciled item set — a headless proxy for "which items exist after add/remove/reorder".
                string tray = string.Join(",", r.Tray.Select(t => t.Name));
                Console.WriteLine($"[settsitems] applied={r.Applied} roots={items.Length} size={r.Width}x{r.Height} png={r.Png.Length}B tray=[{tray}]{(r.Diagnostics.Length > 0 ? " diag=" + r.Diagnostics : "")}");
                return r.Applied ? 0 : 2;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[settsitems] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

        /// <summary>Headless self-test for the net48 live string-array picture: set the string[] owner.propName (Lines)
        /// on the live compiled instance from <c>--items</c> (a comma-separated list; empty → an empty array that clears
        /// the value) and report the new render. Drives the whole path (DomainManager → child AppDomain → STA →
        /// pd.SetValue(string[])).</summary>
        private static int SetLinesCli(string[] args, string designer)
        {
            string? asm = Value(args, "--asm");
            if (asm == null) { Console.Error.WriteLine("--asm <assemblyPath> required"); return 5; }
            string id = Value(args, "--id") ?? "this";
            string prop = Value(args, "--prop") ?? "Lines";
            string itemsCsv = Value(args, "--items") ?? "";
            var probes = args.Select((a, i) => (a, i)).Where(x => x.a == "--probe").Select(x => args[x.i + 1]).ToArray();
            var values = itemsCsv.Length == 0 ? Array.Empty<string>() : itemsCsv.Split(',');

            var api = new EngineApi();
            try
            {
                var r = api.SetCompiledStringArrayLive(designer, asm, id, prop, values, null, probes);
                Console.WriteLine($"[setlines] applied={r.Applied} prop={prop} items={values.Length} size={r.Width}x{r.Height} png={r.Png.Length}B{(r.Diagnostics.Length > 0 ? " diag=" + r.Diagnostics : "")}");
                return r.Applied ? 0 : 2;
            }
            catch (Exception ex)
            {
                for (var e = ex; e != null; e = e.InnerException)
                    Console.Error.WriteLine($"[setlines] {e.GetType().FullName}: {e.Message}");
                return 4;
            }
        }

        /// <summary>Parse the <c>--nodes</c> mini-syntax into a LiveTreeNode forest (one child level): roots are
        /// comma-separated; a root "text&gt;a;b" gets children a, b. Empty → an empty forest (clears the tree).</summary>
        private static LiveTreeNode[] ParseNodesSpec(string spec)
        {
            if (string.IsNullOrEmpty(spec)) return Array.Empty<LiveTreeNode>();
            return spec.Split(',').Select(rootSpec =>
            {
                var parts = rootSpec.Split('>');
                var children = parts.Length > 1
                    ? parts[1].Split(';').Where(s => s.Length > 0).Select(s => new LiveTreeNode { Text = s }).ToArray()
                    : Array.Empty<LiveTreeNode>();
                return new LiveTreeNode { Text = parts[0], Children = children };
            }).ToArray();
        }

        /// <summary>Build a ToolStrip item forest from depth-flattened "depth|id|text|itemType" tokens (CLI self-test):
        /// a token deeper than the previous one nests as a DropDownItems child of the nearest shallower item. Mirrors
        /// the host's depth-based flatten of the resolved <see cref="LiveToolStripItem"/> forest.</summary>
        private static LiveToolStripItem[] BuildToolStripForest(string[] specs)
        {
            var roots = new System.Collections.Generic.List<LiveToolStripItem>();
            var stack = new System.Collections.Generic.List<(int depth, LiveToolStripItem item)>();
            foreach (var spec in specs)
            {
                var parts = spec.Split('|');
                int depth = parts.Length > 0 && int.TryParse(parts[0], out var d) ? d : 0;
                var item = new LiveToolStripItem
                {
                    Id = parts.Length > 1 ? parts[1] : "",
                    Text = parts.Length > 2 ? parts[2] : "",
                    ItemType = parts.Length > 3 ? parts[3] : "",
                };
                while (stack.Count > 0 && stack[stack.Count - 1].depth >= depth) stack.RemoveAt(stack.Count - 1);
                if (depth == 0 || stack.Count == 0) roots.Add(item);
                else
                {
                    var parent = stack[stack.Count - 1].item;
                    var kids = new System.Collections.Generic.List<LiveToolStripItem>(parent.Children) { item };
                    parent.Children = kids.ToArray();
                }
                stack.Add((depth, item));
            }
            return roots.ToArray();
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

    /// <summary>JSON-RPC surface. ALL RPCs are implemented (render/layout/describe/live edits/release);
    /// <see cref="GetCapabilities"/> reports Render=true, Edit=true, LivePreviewUnsavedEdits=false — live edits
    /// mirror the committed net9 source splice onto the cached compiled instance; manual source edits appear after
    /// a rebuild. (An earlier revision of this comment claimed edit RPCs report unsupported — long stale, and it
    /// mis-scoped a months-scale plan once.)</summary>
    public sealed class EngineApi
    {
        private readonly DomainManager _domains = new DomainManager();

        public string Ping() => "winforms-engine-net48 ok / " + RuntimeInformation.FrameworkDescription;

        /// <summary>0.11.0 ImageList editor — serialize the given images + settings into a VS-format ImageStream base64
        /// payload (the one op that needs the .NET Framework runtime; the net9 interpreter can't serialize an
        /// ImageListStreamer). No compiled assembly is touched — this builds a fresh ImageList from raw bytes, so the
        /// host may route it through the bundled net48 engine even for a pure .NET project. The host embeds the payload
        /// into the sibling .resx (net9 XML upsert) + emits the designer edit. POSITIONAL params (matching every other
        /// RPC on this engine) so vscode-jsonrpc sends a params ARRAY, not a single object it would treat as named args.</summary>
        public ImageStreamResult SerializeImageList(ImageListImage[] images, int width, int height, string colorDepth, string transparentColor) =>
            ImageListSerializer.Serialize(new ImageListSpec
            {
                Images = images ?? Array.Empty<ImageListImage>(),
                Width = width,
                Height = height,
                ColorDepth = colorDepth ?? "",
                TransparentColor = transparentColor ?? "",
            });

        /// <summary>0.11.0 ImageList editor (READ side) — deserialize a VS-format ImageStream base64 blob back to the
        /// current per-image PNG bytes + keys, so the editor can show the existing images before the user edits. Works
        /// for any project (the bundled net48 engine owns the binary (de)serialization); Ok=false on a foreign blob.</summary>
        public ImageListReadResult DeserializeImageList(string base64) => ImageListSerializer.Deserialize(base64 ?? "");

        /// <summary>0.11.0 net48 undo reconcile — drop the cached live compiled instance for this form so the NEXT render
        /// re-instantiates from the compiled baseline. The host calls this on undo/redo/revert (net48 renders the
        /// instance, not the reverted text, so the cache would otherwise keep showing the undone edit). Idempotent;
        /// returns true if an instance was dropped. Uses the SAME type resolution as the render so the key matches.</summary>
        public bool DiscardCompiledLive(string designerFilePath, string assemblyPath, string? rootTypeName = null, string[]? probeDirs = null)
        {
            if (string.IsNullOrWhiteSpace(assemblyPath) || !File.Exists(assemblyPath)) return false;
            try
            {
                string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
                var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
                return worker.DiscardLive(assemblyPath, typeName);
            }
            catch { return false; }
        }

        /// <summary>1.0.0 — release every handle this process holds on the project's build output, by unloading the
        /// child AppDomain that loaded it. Idempotent; returns a <see cref="ReleaseResult"/> ({Attempted, Released,
        /// Failed}) so the host can tell "nothing was loaded" (Attempted 0) from "found it but the unload FAILED and it
        /// still pins the dll" (Failed > 0) — the two used to both read as a bare false.
        ///
        /// The net48 preview loads the user's dlls IN PLACE (ShadowCopyFiles must stay off, or delay-signed vendor
        /// assemblies fail to load — see DomainManager.Create), which pins them: while a net48 designer is open, the
        /// user's own `dotnet build` fails with MSB3027 "The file is locked by: WinFormsDesigner.Engine.Net48". The
        /// host calls this when the last session using an output closes, and from the "release for rebuild" command,
        /// so the user can actually rebuild — which every "rebuild to refresh the preview" instruction assumed.
        ///
        /// Deliberately keyed on the OUTPUT DIRECTORY, not the form: one domain serves every form built into the same
        /// bin dir, so releasing on behalf of one form releases them all. That is why the host refcounts sessions per
        /// assembly and only calls this for the last one.
        ///
        /// Unlike DiscardCompiledLive (which drops one cached form instance but keeps the domain — and therefore the
        /// file handles — alive), this tears the domain down. The next render pays a full domain+assembly load, so it
        /// is not a per-edit operation.</summary>
        public ReleaseResult ReleaseCompiledAssembly(string assemblyPath)
        {
            if (string.IsNullOrWhiteSpace(assemblyPath)) return new ReleaseResult { Attempted = 0, Released = 0, Failed = 0 };
            try { return _domains.ReleaseBinDir(assemblyPath); }
            // A crash in the release path must never take the engine down. Report Failed=1 (not "nothing loaded") so
            // the host treats it as a doubtful release and can recycle, rather than falsely claiming it's safe to build.
            catch { return new ReleaseResult { Attempted = 1, Released = 0, Failed = 1 }; }
        }

        /// <summary>1.0.0 — release EVERY build output this engine currently holds open; returns a
        /// <see cref="ReleaseResult"/> ({Attempted, Released, Failed}) — Failed > 0 means a domain refused to unload and
        /// still pins its dll, so the host recycles the process. Backs the project-wide "release for rebuild" command.
        ///
        /// The host asks the engine rather than naming directories itself because only the engine knows what it really
        /// loaded: a session that switched control source forgets the output it previously pinned, so a host-derived
        /// list silently misses it and that project stays unbuildable.</summary>
        public ReleaseResult ReleaseAllCompiledAssemblies()
        {
            // Do NOT swallow into {0,0,0} — the host reads that triple as "nothing was held", which would leave every
            // domain pinned while the command reports it's safe to rebuild. Let the exception cross the
            // RPC; the host's release path catches an errored/timed-out release and RECYCLES the engine, which is the
            // correct fail-safe when the release accounting itself is in doubt.
            return _domains.ReleaseAll();
        }

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
            string? rootTypeName = null, string[]? probeDirs = null, int width = 0, int height = 0, int renderScale = 1)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.RenderWithLayout(assemblyPath, typeName, width, height, renderScale);
        }

        /// <summary>Render the LIVE .Designer.cs source through the IR interpreter (VS model), or fall
        /// back to the compiled last build with a named reason. The host passes the unsaved buffer as
        /// <paramref name="sourceText"/>; the result's RenderMode/FallbackReason drive the two-axis mode + banner.</summary>
        public RenderLayoutResult RenderInterpretedWithLayout(string designerFilePath, string assemblyPath, string sourceText,
            string? rootTypeName = null, string[]? probeDirs = null, int width = 0, int height = 0, string[]? selectedTabs = null, int renderScale = 1)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            // Parse the source into IR HERE, in the engine's DEFAULT AppDomain — Roslyn must never load into the render
            // child domain (its binding redirects are unified on the user's assembly versions, which would redirect
            // Roslyn's own graph, e.g. System.Collections.Immutable, and break it). Only the [Serializable] IrDocument
            // crosses the boundary. RootTypeResolver/SourceMetadata already parse here.
            // selectedTabs () = transient "hostField=pageField" tab overrides, re-supplied each render.
            var doc = DesignerIrBuilder.Build(sourceText ?? "");
            return worker.RenderInterpretedWithLayout(designerFilePath, assemblyPath, doc, typeName, width, height, selectedTabs, renderScale);
        }

        /// <summary>describe one component of the INTERPRETED live-source instance so the
        /// property panel matches the interpreted canvas on an unsaved edit. Roslyn parses the buffer into IR HERE (the
        /// default AppDomain invariant); the worker builds a request-local interpreted graph and describes the
        /// target from the executor's identity model. Returns null when the form doesn't fully interpret or the id names
        /// no current component — the host then keeps the panel unavailable (never compiled values under an interpreted
        /// canvas). Source metadata (assigned-in-source, wired events) is applied HERE from the same buffer.</summary>
        public ComponentDesc? DescribeInterpretedComponent(string designerFilePath, string assemblyPath, string sourceText,
            string componentId, string? rootTypeName = null, string[]? probeDirs = null, int width = 0, int height = 0)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            var doc = DesignerIrBuilder.Build(sourceText ?? "");
            var desc = worker.DescribeInterpretedComponent(designerFilePath, assemblyPath, doc, typeName,
                string.IsNullOrEmpty(componentId) ? "this" : componentId, width, height);
            if (desc != null) SourceMetadata.Apply(desc, designerFilePath, string.IsNullOrWhiteSpace(sourceText) ? null : sourceText);
            return desc;
        }

        /// <summary>Property-grid + events for one control of the LIVE compiled instance ("this" = root, else its
        /// .Designer.cs field name) — the read side behind the property panel in compiled-preview mode.</summary>
        public ComponentDesc? DescribeCompiledComponent(string designerFilePath, string assemblyPath, string componentId,
            string? rootTypeName = null, string[]? probeDirs = null, string? sourceText = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            var desc = worker.DescribeComponent(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId);
            // enrich with source-only facts the live TypeDescriptor can't see (Roslyn in the HOST domain): which
            // properties were assigned in source (grid bold) + which event handlers were wired (Events tab). When the host
            // passes the UNSAVED buffer (sourceText), parse THAT so an item's just-wired event / just-reset prop is fresh.
            SourceMetadata.Apply(desc, designerFilePath, string.IsNullOrWhiteSpace(sourceText) ? null : sourceText);
            return desc;
        }

        /// <summary>The vendor smart-tag menu a control's compiled type declares (the DevExpress "Tasks" panel:
        /// "Add Tab Page", "Tab Pages", …). Metadata only — the vendor's action is never invoked; the host maps the
        /// verbs it can express onto its own source-first edits and shows the rest disabled. [] on any failure.</summary>
        public VendorSmartTag[] ListCompiledVendorSmartTags(string designerFilePath, string assemblyPath, string componentId,
            string? rootTypeName = null, string[]? probeDirs = null)
        {
            if (string.IsNullOrWhiteSpace(assemblyPath) || !File.Exists(assemblyPath)) return Array.Empty<VendorSmartTag>();
            try
            {
                string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
                var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
                return worker.ListVendorSmartTags(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId);
            }
            catch { return Array.Empty<VendorSmartTag>(); }
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

        /// <summary>Choose Toolbox Items scan for a .NET Framework/project/GAC assembly. Unlike the live compiled
        /// palette enumeration, this uses a dedicated short-lived AppDomain and unloads it before returning, so merely
        /// opening the dialog never pins a project output or browsed vendor library.</summary>
        public ToolboxScanResult ScanToolboxAssembly(string assemblyPath, string[]? probeDirs = null)
        {
            string simpleName = string.IsNullOrWhiteSpace(assemblyPath) ? "" : Path.GetFileNameWithoutExtension(assemblyPath);
            if (string.IsNullOrWhiteSpace(assemblyPath) || !File.Exists(assemblyPath))
                return new ToolboxScanResult { AssemblyName = simpleName, Error = "file not found" };
            AppDomain? domain = null;
            try
            {
                var setup = new AppDomainSetup
                {
                    ApplicationBase = AppDomain.CurrentDomain.BaseDirectory,
                };
                domain = AppDomain.CreateDomain("WfdToolboxScan-" + Guid.NewGuid().ToString("N"), null, setup);
                var scanner = (ToolboxAssemblyScanner)domain.CreateInstanceAndUnwrap(
                    typeof(ToolboxAssemblyScanner).Assembly.FullName,
                    typeof(ToolboxAssemblyScanner).FullName);
                return scanner.Scan(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            }
            catch (Exception ex)
            {
                return new ToolboxScanResult { AssemblyName = simpleName, Error = ex.GetBaseException().Message };
            }
            finally
            {
                if (domain != null)
                {
                    try { AppDomain.Unload(domain); } catch { /* process exit/release remains the ultimate cleanup */ }
                }
            }
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

        /// <summary>Reset ONE property on the live compiled instance to its default (pd.ResetValue) + re-render — the
        /// picture half of a per-property Reset. The persisted text delete is the host's job (net9 splice); this
        /// returns the fresh picture + layout so the net48 preview matches the now-default value.</summary>
        public RenderLayoutResult ResetCompiledPropertyLive(string designerFilePath, string assemblyPath, string componentId,
            string propName, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.ResetPropertyLive(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId, propName);
        }

        /// <summary>Reconstruct a typed collection (string Items / ListView.Columns / DataGridView.Columns) on the live
        /// compiled instance from the net9-committed item data + re-render — the net48 live picture for the "…" collection
        /// editor (T1.1b). itemType is the describe CollectionItemType. Applied=false + a reason when it can't be rebuilt
        /// live (bound/unsupported); the persisted text still renders after a rebuild.</summary>
        public RenderLayoutResult SetCompiledCollectionLive(string designerFilePath, string assemblyPath, string componentId,
            string propName, string itemType, LiveCollItem[] items, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.SetCollectionLive(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId,
                propName ?? "", itemType ?? "", items ?? Array.Empty<LiveCollItem>());
        }

        /// <summary>Reconstruct a TreeView's Nodes on the live compiled instance from the net9-committed node forest +
        /// re-render — the net48 live picture for the hierarchical "…" TreeNode editor (the TreeView analogue of
        /// <see cref="SetCompiledCollectionLive"/>). The host sends its recursive TreeNodeItem shape (id/text/name/children);
        /// only text/name/children are read (`id` is ignored on deserialize). Applied=false + a reason when it can't be
        /// rebuilt live (a DevExpress TreeList's non-TreeNodeCollection Nodes); the persisted text renders after a rebuild.</summary>
        public RenderLayoutResult SetCompiledTreeNodesLive(string designerFilePath, string assemblyPath, string componentId,
            string propName, LiveTreeNode[] nodes, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.SetTreeNodesLive(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId,
                string.IsNullOrEmpty(propName) ? "Nodes" : propName, nodes ?? Array.Empty<LiveTreeNode>());
        }

        /// <summary>Reconcile a ToolStrip/MenuStrip's items (add/remove/rename/reorder) on the live compiled instance
        /// from the net9-committed forest + re-render — the net48 live picture for the "…" ToolStrip item editor. The
        /// host sends the resolved <see cref="LiveToolStripItem"/> forest (every field id populated, incl. minted ids
        /// for adds); items are reconciled surgically by id so unmodelled props (Image/events) survive. Applied=false
        /// + a reason when the owner isn't a live ToolStrip or a new item type can't be constructed; the persisted
        /// text still renders after a rebuild.</summary>
        public RenderLayoutResult SetCompiledToolStripItemsLive(string designerFilePath, string assemblyPath, string componentId,
            LiveToolStripItem[] items, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.SetToolStripItemsLive(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId,
                items ?? Array.Empty<LiveToolStripItem>());
        }

        /// <summary>Set a generic string[] property (TextBox/RichTextBox.Lines) on the live compiled instance from the
        /// net9-committed values + re-render — the net48 live picture for the "…" string-array editor (mirror of
        /// <see cref="SetCompiledCollectionLive"/>). Applied=false + a reason when the property isn't a writable
        /// string[]; the persisted text still renders after a rebuild. No custom DTO — string[] is a framework
        /// [Serializable] type that crosses the JSON-RPC + child-AppDomain boundary on its own.</summary>
        public RenderLayoutResult SetCompiledStringArrayLive(string designerFilePath, string assemblyPath, string componentId,
            string propName, string[] values, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.SetStringArrayLive(assemblyPath, typeName, string.IsNullOrEmpty(componentId) ? "this" : componentId,
                propName ?? "", values ?? Array.Empty<string>());
        }

        /// <summary>Apply a BATCH of property edits to the live instance + re-render once (drag/resize/align).</summary>
        /// <summary>Reconcile a source/.resx ImageList edit on the cached compiled instance so the net48 canvas updates
        /// immediately instead of waiting for a project rebuild.</summary>
        public RenderLayoutResult SetCompiledImageListLive(string designerFilePath, string assemblyPath, string componentId,
            string imageStreamBase64, string[] keys, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            return worker.SetImageListLive(assemblyPath, typeName, componentId ?? "", imageStreamBase64 ?? "", keys ?? Array.Empty<string>());
        }

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

        /// <summary>the INTERPRETED tab hit-test: which page's header is under the point on the
        /// LIVE-SOURCE geometry, so a tab-click on an interpreted canvas resolves to a page and the host re-renders
        /// interpreted with that page selected (staying interpreted). Roslyn parses in the DEFAULT domain; the
        /// [Serializable] IR + the transient selectedTabs cross to the worker. PageId "" when off a header / not a tab
        /// host / not interpretable.</summary>
        public TabHit HitTestInterpretedTab(string designerFilePath, string assemblyPath, string sourceText, string hostId,
            int x, int y, string[]? selectedTabs = null, string? rootTypeName = null, string[]? probeDirs = null)
        {
            string typeName = ResolveTypeName(designerFilePath, assemblyPath, rootTypeName);
            var worker = _domains.GetWorker(assemblyPath, ComputeProbes(assemblyPath, probeDirs));
            var doc = DesignerIrBuilder.Build(sourceText ?? "");
            return worker.HitTestInterpretedTab(designerFilePath, assemblyPath, doc, typeName, hostId ?? "this", x, y, selectedTabs);
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

        /// <summary>Env var carrying extra assembly-probe dirs (PATH-style, <see cref="Path.PathSeparator"/>-separated).
        /// The VS Code host sets it from the `winformsDesigner.net48.probeDirectories` setting when it spawns this
        /// engine; the --render CLI honors it too. This is the ONLY source of vendor-specific probe locations — no
        /// install path is hardcoded here, so any user can point the resolver at their own SDK.</summary>
        internal const string ProbeDirsEnvVar = "WINFORMS_DESIGNER_PROBE_DIRS";

        /// <summary>Fallback probe dirs for one target, in precedence order: caller-supplied (RPC `probeDirs`), the
        /// target's own bin dir, then the user-configured dirs from <see cref="ProbeDirsEnvVar"/> (a vendor SDK
        /// installed outside the target's output and out of the GAC). Non-existent dirs are dropped, so a stale
        /// setting degrades to "not probed" rather than breaking resolution.</summary>
        private static string[] ComputeProbes(string assemblyPath, string[]? probeDirs)
        {
            string binDir = Path.GetDirectoryName(Path.GetFullPath(assemblyPath))!;
            return (probeDirs ?? Array.Empty<string>())
                .Concat(new[] { binDir })
                .Concat(EnvProbeDirs())
                .Where(Directory.Exists)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        /// <summary>Parse <see cref="ProbeDirsEnvVar"/>. Read per call (not cached) so it stays a pure function of the
        /// environment; the value is a handful of paths, and Directory.Exists above dominates the cost either way.</summary>
        private static string[] EnvProbeDirs()
        {
            string raw = Environment.GetEnvironmentVariable(ProbeDirsEnvVar) ?? string.Empty;
            return raw.Split(new[] { Path.PathSeparator }, StringSplitOptions.RemoveEmptyEntries)
                .Select(d => d.Trim())
                .Where(d => d.Length > 0)
                .ToArray();
        }
    }
}
