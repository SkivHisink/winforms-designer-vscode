using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using StreamJsonRpc;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// V1a engine host. Two modes:
    ///   --selftest &lt;designerFile&gt; [outPng]   render once, write PNG, print stats (no pipe)
    ///   --pipe &lt;name&gt;                          run JSON-RPC server on a named pipe
    /// All WinForms work is marshaled onto a single dedicated STA thread (StaDispatcher).
    /// </summary>
    internal static class Program
    {
        private static async Task<int> Main(string[] args)
        {
            var sta = new StaDispatcher();

            // Pre-warm project-output resolution off the STA thread (mirrors EngineApi.Prewarm): the
            // STA-side render resolves with allowEval:false, so this warms the cache and keeps CLI
            // auto-resolve on the MSBuild strategy. No-op when an explicit --asm is supplied.
            void WarmResolve(string designerFile, string? explicitAsm)
            {
                if (string.IsNullOrEmpty(explicitAsm)) ProjectResolver.ResolveOutputAssembly(designerFile);
            }

            if (Has(args, "--selftest", out string? file) && file != null)
            {
                string outPng = ArgAfter(args, "--out") ?? Path.Combine(AppContext.BaseDirectory, "selftest.png");
                string? asm = ArgAfter(args, "--asm");
                try
                {
                    WarmResolve(file, asm);
                    var res = sta.Invoke(() => DesignerRenderer.RenderDetailed(file, asm));
                    File.WriteAllBytes(outPng, res.Png);
                    Console.WriteLine("== engine selftest");
                    Console.WriteLine("   runtime      : " + RuntimeInformation.FrameworkDescription);
                    Console.WriteLine("   root type    : " + res.RootType);
                    Console.WriteLine("   statements   : " + res.TotalStatements + " (representable " + res.Representable + ")");
                    Console.WriteLine("   unrepresent. : " + res.Unrepresentable.Count);
                    foreach (var u in res.Unrepresentable) Console.WriteLine("       " + u);
                    Console.WriteLine("   png          : " + res.Width + "x" + res.Height + ", " + res.Png.Length + " bytes -> " + outPng);
                    Console.WriteLine(res.Png.Length > 0 ? "RESULT: PASS" : "RESULT: FAIL");
                    return res.Png.Length > 0 ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--selftest-custom", out string? customDll) && customDll != null)
            {
                string typeName = ArgAfter(args, "--type") ?? "CustomControls.GaugeControl";
                string outPng = ArgAfter(args, "--out") ?? Path.Combine(AppContext.BaseDirectory, "selftest-custom.png");
                try
                {
                    var res = sta.Invoke(() => DesignerRenderer.RenderCustomControl(customDll, typeName));
                    File.WriteAllBytes(outPng, res.Png);
                    Console.WriteLine("== engine selftest-custom (collectible ALC)");
                    Console.WriteLine("   runtime : " + RuntimeInformation.FrameworkDescription);
                    Console.WriteLine("   loaded  : " + res.RootType);
                    Console.WriteLine("   png     : " + res.Width + "x" + res.Height + ", " + res.Png.Length + " bytes -> " + outPng);
                    Console.WriteLine(res.Png.Length > 0 ? "RESULT: PASS" : "RESULT: FAIL");
                    return res.Png.Length > 0 ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--roundtrip", out string? rtFile) && rtFile != null)
            {
                string? asm = ArgAfter(args, "--asm");
                string? outCs = ArgAfter(args, "--out");
                try
                {
                    WarmResolve(rtFile, asm);
                    var res = sta.Invoke(() => DesignerRenderer.SerializeFromFile(rtFile, asm));
                    Console.WriteLine("== engine roundtrip (load -> serialize, §6.3 normalization)");
                    Console.WriteLine("   runtime        : " + RuntimeInformation.FrameworkDescription);
                    Console.WriteLine("   class          : " + res.ClassName);
                    Console.WriteLine("   statements     : " + res.TotalStatements + " (representable " + res.Representable + ")");
                    Console.WriteLine("   round-trip safe: " + res.RoundTripSafe + " (unrepresentable " + res.Unrepresentable.Count + ")");
                    foreach (var u in res.Unrepresentable) Console.WriteLine("       ! " + u);
                    Console.WriteLine("   over-emit removed: " + res.DefaultsDropped);
                    foreach (var d in res.DroppedDefaults) Console.WriteLine("       - " + d);

                    // diagnostic only (NOT a pass gate): for the default-free fixtures, confirm the
                    // spurious defaults are gone. Explicit-mode legitimately keeps a source-explicit
                    // Enabled=true/Visible=true, so raw-string absence must not gate pass/fail.
                    Console.WriteLine("   no spurious Enabled=true: " + !res.Code.Contains(".Enabled = true")
                                      + " | Visible=true: " + !res.Code.Contains(".Visible = true"));

                    // §6.5: a file is safe to round-trip back to disk ONLY when fully representable.
                    bool pass = res.RoundTripSafe;
                    if (pass)
                    {
                        if (outCs != null)
                        {
                            File.WriteAllText(outCs, res.Code);
                            File.WriteAllText(outCs + ".raw.cs", res.RawCode);
                            Console.WriteLine("   wrote          : " + outCs + " (+ .raw.cs)");
                        }
                    }
                    else
                    {
                        // never overwrite the source with a lossy result — skip --out entirely
                        Console.WriteLine("WARNING: source has unrepresentable constructs — NOT safe to save (read-only fallback); --out skipped");
                    }
                    Console.WriteLine();
                    Console.WriteLine("--- normalized InitializeComponent ---");
                    Console.WriteLine(res.Code);
                    Console.WriteLine(pass ? "RESULT: PASS" : "RESULT: FAIL");
                    return pass ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--save", out string? saveFile) && saveFile != null)
            {
                string? asm = ArgAfter(args, "--asm");
                bool write = Has(args, "--write", out _);
                try
                {
                    WarmResolve(saveFile, asm);
                    var res = sta.Invoke(() => DesignerRenderer.SaveSplice(saveFile, asm));
                    Console.WriteLine("== engine save-splice (normalized InitializeComponent -> existing file)");
                    Console.WriteLine("   runtime        : " + RuntimeInformation.FrameworkDescription);
                    Console.WriteLine("   class          : " + res.RoundTrip.ClassName);
                    Console.WriteLine("   round-trip safe: " + res.RoundTrip.RoundTripSafe
                                      + " (unrepresentable " + res.RoundTrip.Unrepresentable.Count + ")");
                    foreach (var u in res.RoundTrip.Unrepresentable) Console.WriteLine("       ! " + u);
                    if (res.MissingStatements.Count > 0)
                    {
                        Console.WriteLine("   statements lost by re-serialization (§6.5): " + res.MissingStatements.Count);
                        foreach (var m in res.MissingStatements) Console.WriteLine("       ? " + m);
                    }

                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: source not safe to round-trip — refusing to write (read-only fallback)");
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }

                    if (write)
                    {
                        // §6.6 transactional write: hard pre-save backup (byte copy), then overwrite in the original encoding
                        string bak = saveFile + ".bak";
                        File.Copy(saveFile, bak, overwrite: true);
                        File.WriteAllText(saveFile, res.SplicedText!, res.Encoding);
                        Console.WriteLine("   APPLIED        : wrote " + saveFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        // .txt (not .cs) so SDK-style projects never compile the preview as a duplicate partial
                        string preview = saveFile + ".spliced.txt";
                        File.WriteAllText(preview, res.SplicedText!, res.Encoding);
                        Console.WriteLine("   dry-run        : wrote preview " + preview + " (use --write to apply)");
                    }
                    Console.WriteLine("RESULT: PASS");
                    return 0;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--describe", out string? dFile) && dFile != null)
            {
                string? asm = ArgAfter(args, "--asm");
                string? only = ArgAfter(args, "--comp"); // bounded single-component path
                try
                {
                    WarmResolve(dFile, asm);
                    void PrintComponent(ComponentInfo c)
                    {
                        int setCount = c.Properties.Count(p => p.SourceExplicit);
                        string parent = c.Parent == null ? "" : "  (in " + c.Parent + ")";
                        Console.WriteLine("   • " + c.Name + " [id=" + c.Id + "] : " + c.Type + parent
                                          + "  [" + c.Properties.Count + " props, " + setCount + " in source]");
                        foreach (var p in c.Properties.Where(p => p.SourceExplicit))
                        {
                            Console.WriteLine("       " + p.Name + " = " + (p.Value ?? "<null>"));
                        }
                        var wired = c.Events.Where(ev => ev.Handler != null).ToList();
                        if (wired.Count > 0)
                        {
                            Console.WriteLine("       events: " + c.Events.Count + " (" + wired.Count + " wired)");
                            foreach (var ev in wired)
                            {
                                Console.WriteLine("         " + ev.Name + " -> " + ev.Handler);
                            }
                        }
                    }

                    if (only != null)
                    {
                        var ci = sta.Invoke(() => DesignerRenderer.DescribeComponent(dFile, only, asm));
                        Console.WriteLine("== engine describe-component '" + only + "'");
                        if (ci == null) { Console.WriteLine("component not found: " + only); Console.WriteLine("RESULT: FAIL"); return 1; }
                        PrintComponent(ci);
                        Console.WriteLine("RESULT: PASS");
                        return 0;
                    }

                    var res = sta.Invoke(() => DesignerRenderer.Describe(dFile, asm));
                    Console.WriteLine("== engine describe (controls + properties)");
                    Console.WriteLine("   runtime    : " + RuntimeInformation.FrameworkDescription);
                    Console.WriteLine("   root type  : " + res.RootType);
                    Console.WriteLine("   components : " + res.Components.Count
                                      + " | statements " + res.TotalStatements
                                      + " (repr " + res.Representable + ", safe " + res.RoundTripSafe + ")");
                    foreach (var c in res.Components) PrintComponent(c);
                    Console.WriteLine(res.Components.Count > 0 ? "RESULT: PASS" : "RESULT: FAIL");
                    return res.Components.Count > 0 ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--set-prop", out string? spFile) && spFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "this";
                string? prop = ArgAfter(args, "--prop");
                string? value = ArgAfter(args, "--value");
                bool write = Has(args, "--write", out _);
                if (prop == null || value == null)
                {
                    Console.WriteLine("usage: --set-prop <file> [--comp <name>] --prop <name> --value <expr> [--write]");
                    return 2;
                }
                try
                {
                    var res = DesignerRenderer.ApplyPropertyEdit(spFile, comp, prop, value);
                    Console.WriteLine("== engine set-property (targeted byte-minimal edit)");
                    Console.WriteLine("   target : " + comp + "." + prop + " = " + value);
                    Console.WriteLine("   mode   : " + res.Mode + " | parse-ok: " + res.ParseOk + " | minimal: " + res.Minimal);
                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        string bak = spFile + ".bak";
                        File.Copy(spFile, bak, overwrite: true);
                        File.WriteAllText(spFile, res.NewText!, res.Encoding);
                        Console.WriteLine("   APPLIED: wrote " + spFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        string preview = spFile + ".edited.txt";
                        File.WriteAllText(preview, res.NewText!, res.Encoding);
                        Console.WriteLine("   dry-run: wrote preview " + preview + " (use --write to apply)");
                    }
                    Console.WriteLine("RESULT: PASS");
                    return 0;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--convert", out string? convType) && convType != null)
            {
                string? value = ArgAfter(args, "--value");
                if (value == null)
                {
                    Console.WriteLine("usage: --convert <typeName> --value <invariantValue>");
                    return 2;
                }
                try
                {
                    string? expr = DesignerValueConverter.ToExpression(convType, value);
                    Console.WriteLine("== engine convert-value (invariant string -> C# initializer expression)");
                    Console.WriteLine("   type  : " + convType);
                    Console.WriteLine("   value : " + value);
                    Console.WriteLine("   expr  : " + (expr ?? "<not convertible>"));
                    Console.WriteLine(expr != null ? "RESULT: PASS" : "RESULT: FAIL");
                    return expr != null ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--render-control", out string? rcFile) && rcFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "this";
                string? asm = ArgAfter(args, "--asm");
                string outPng = ArgAfter(args, "--out") ?? Path.Combine(AppContext.BaseDirectory, "render-control.png");
                try
                {
                    WarmResolve(rcFile, asm);
                    var res = sta.Invoke(() => DesignerRenderer.RenderControl(rcFile, comp, asm));
                    if (!res.Found)
                    {
                        Console.WriteLine("RESULT: FAIL — component not found: " + comp);
                        return 1;
                    }
                    File.WriteAllBytes(outPng, res.Png);
                    int colors = DistinctColors(res.Png);
                    Console.WriteLine("== engine render-control (dirty-region: single control to PNG + placement)");
                    Console.WriteLine("   component      : " + comp);
                    Console.WriteLine("   bounds (client): x=" + res.X + " y=" + res.Y + " w=" + res.Width + " h=" + res.Height);
                    Console.WriteLine("   png            : " + res.Png.Length + " bytes -> " + outPng);
                    Console.WriteLine("   distinct colors: " + colors + (colors > 1 ? " (non-blank)" : " (BLANK — per-control capture failed)"));
                    bool pass = res.Png.Length > 0 && colors > 1;
                    Console.WriteLine(pass ? "RESULT: PASS" : "RESULT: FAIL");
                    return pass ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--layout", out string? layoutFile) && layoutFile != null)
            {
                string? asm = ArgAfter(args, "--asm");
                try
                {
                    WarmResolve(layoutFile, asm);
                    var res = sta.Invoke(() => DesignerRenderer.DescribeLayout(layoutFile, asm));
                    Console.WriteLine("== engine layout (control window-space bounds for click-to-select)");
                    Console.WriteLine("   runtime  : " + RuntimeInformation.FrameworkDescription);
                    Console.WriteLine("   root     : " + res.RootType + "  frame " + res.Width + "x" + res.Height);
                    foreach (var c in res.Controls)
                    {
                        Console.WriteLine("   • " + (c.IsRoot ? "[root] " : "") + c.Name + " [id=" + c.Id + "] : " + c.Type
                                          + "  @ (" + c.X + "," + c.Y + ") " + c.Width + "x" + c.Height
                                          + " depth=" + c.Depth + (c.ParentId != null ? " parent=" + c.ParentId : ""));
                    }
                    Console.WriteLine(res.Controls.Count > 0 ? "RESULT: PASS" : "RESULT: FAIL");
                    return res.Controls.Count > 0 ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--render-layout", out string? rlFile) && rlFile != null)
            {
                string? asm = ArgAfter(args, "--asm");
                string outPng = ArgAfter(args, "--out") ?? Path.Combine(AppContext.BaseDirectory, "render-layout.png");
                try
                {
                    WarmResolve(rlFile, asm);
                    var res = sta.Invoke(() => DesignerRenderer.RenderWithLayout(rlFile, asm));
                    File.WriteAllBytes(outPng, res.Png);
                    int colors = DistinctColors(res.Png);
                    Console.WriteLine("== engine render-layout (combined full-frame PNG + hit-test map, ONE graph load)");
                    Console.WriteLine("   runtime  : " + RuntimeInformation.FrameworkDescription);
                    Console.WriteLine("   root     : " + res.RootType + "  frame " + res.Width + "x" + res.Height
                                      + "  (" + res.Representable + "/" + res.TotalStatements + " representable)");
                    Console.WriteLine("   png      : " + res.Png.Length + " bytes -> " + outPng
                                      + "  (" + colors + " distinct colors)");
                    Console.WriteLine("   controls : " + res.Controls.Count);
                    foreach (var c in res.Controls)
                    {
                        Console.WriteLine("   • " + (c.IsRoot ? "[root] " : "") + c.Name + " [id=" + c.Id + "] : " + c.Type
                                          + "  @ (" + c.X + "," + c.Y + ") " + c.Width + "x" + c.Height
                                          + " depth=" + c.Depth + (c.ParentId != null ? " parent=" + c.ParentId : ""));
                    }
                    bool pass = res.Png.Length > 0 && colors > 1 && res.Controls.Count > 0;
                    Console.WriteLine(pass ? "RESULT: PASS" : "RESULT: FAIL");
                    return pass ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--resolve", out string? resolveFile) && resolveFile != null)
            {
                try
                {
                    string? csproj = ProjectResolver.FindCsproj(resolveFile);
                    string? asm = ProjectResolver.ResolveOutputAssembly(resolveFile);
                    Console.WriteLine("== engine resolve (project output assembly via MSBuild design-time eval)");
                    Console.WriteLine("   designer : " + Path.GetFullPath(resolveFile));
                    Console.WriteLine("   csproj   : " + (csproj ?? "<none>"));
                    Console.WriteLine("   assembly : " + (asm ?? "<unresolved>"));
                    Console.WriteLine(asm != null ? "RESULT: PASS" : "RESULT: FAIL");
                    return asm != null ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--toolbox", out string? tbFile))
            {
                var items = DesignerRenderer.ToolboxItems(tbFile, ArgAfter(args, "--asm"));
                Console.WriteLine($"== toolbox palette (§7.2 auto-population): {items.Count} controls");
                foreach (var g in items.GroupBy(i => i.Category).OrderBy(g => g.Key, StringComparer.Ordinal))
                {
                    Console.WriteLine($"-- {g.Key} ({g.Count()})");
                    foreach (var i in g.OrderBy(i => i.Name, StringComparer.Ordinal))
                        Console.WriteLine($"   {i.Name,-22} {i.Fqn}");
                }
                return 0;
            }

            if (Has(args, "--candidates", out string? candFile))
            {
                var browse = ArgAfter(args, "--browse");
                var items = DesignerRenderer.ToolboxCandidates(candFile, ArgAfter(args, "--asm"), browse != null ? new List<string> { browse } : null);
                Console.WriteLine($"== Choose Toolbox Items candidates: {items.Count}");
                foreach (var g in items.GroupBy(i => i.AssemblyName).OrderByDescending(g => g.Count()))
                    Console.WriteLine($"-- {g.Key} ({g.Count()})");
                foreach (var i in items.Take(25))
                    Console.WriteLine($"   {i.Name,-26} {i.Namespace,-32} {i.AssemblyName} {i.Version}");
                return 0;
            }

            if (Has(args, "--pipe", out string? pipeName) && pipeName != null)
            {
                await Console.Error.WriteLineAsync("[engine] listening on pipe: " + pipeName);
                using var pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 1,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous);
                await pipe.WaitForConnectionAsync();
                await Console.Error.WriteLineAsync("[engine] client connected");
                // camelCase DTO serialization so the TypeScript client reads idiomatic JS keys
                // (e.g. component.properties, not .Properties). Method dispatch + positional params
                // are unaffected. Content-Length framing keeps vscode-jsonrpc interop.
                var formatter = new JsonMessageFormatter();
                formatter.JsonSerializer.ContractResolver = new Newtonsoft.Json.Serialization.CamelCasePropertyNamesContractResolver();
                var handler = new HeaderDelimitedMessageHandler(pipe, pipe, formatter);
                var rpc = new JsonRpc(handler, new EngineApi(sta));
                rpc.StartListening();
                await rpc.Completion;
                await Console.Error.WriteLineAsync("[engine] rpc completed");
                return 0;
            }

            Console.WriteLine("usage: Engine --selftest <designerFile> [--out <png>]");
            Console.WriteLine("       Engine --roundtrip <designerFile> [--asm <dll>] [--out <cs>]");
            Console.WriteLine("       Engine --save <designerFile> [--asm <dll>] [--write]   (dry-run unless --write)");
            Console.WriteLine("       Engine --set-prop <designerFile> [--comp <name>] --prop <name> --value <expr> [--write]");
            Console.WriteLine("       Engine --describe <designerFile> [--asm <dll>]");
            Console.WriteLine("       Engine --layout <designerFile> [--asm <dll>]   (control window-space bounds for click-to-select)");
            Console.WriteLine("       Engine --render-layout <designerFile> [--asm <dll>] [--out <png>]   (combined full-frame PNG + hit-test map, one graph load)");
            Console.WriteLine("       Engine --convert <typeName> --value <invariantValue>");
            Console.WriteLine("       Engine --resolve <designerFile>   (print MSBuild-resolved output assembly)");
            Console.WriteLine("       Engine --pipe <name>");
            return 2;
        }

        /// <summary>Count distinct pixel colors (capped) — a blank capture has 1; used to verify a render isn't empty.</summary>
        private static int DistinctColors(byte[] png)
        {
            using var ms = new System.IO.MemoryStream(png);
            using var bmp = new System.Drawing.Bitmap(ms);
            var set = new System.Collections.Generic.HashSet<int>();
            for (int y = 0; y < bmp.Height && set.Count < 64; y++)
            {
                for (int x = 0; x < bmp.Width && set.Count < 64; x++)
                {
                    set.Add(bmp.GetPixel(x, y).ToArgb());
                }
            }
            return set.Count;
        }

        private static bool Has(string[] args, string flag, out string? value)
        {
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == flag)
                {
                    value = i + 1 < args.Length ? args[i + 1] : null;
                    return true;
                }
            }
            value = null;
            return false;
        }

        private static string? ArgAfter(string[] args, string flag)
        {
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == flag) return args[i + 1];
            }
            return null;
        }
    }

    /// <summary>JSON-RPC surface exposed to the VS Code extension.</summary>
    public sealed class EngineApi
    {
        private readonly StaDispatcher _sta;
        public EngineApi(StaDispatcher sta) => _sta = sta;

        public string Ping() => "winforms-engine ok / " + RuntimeInformation.FrameworkDescription;

        /// <summary>Blank/whitespace → null, so a client can send "" to mean "auto-discover the assembly".</summary>
        private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s;

        /// <summary>
        /// Warm project-output resolution OFF the STA thread, so the MSBuild subprocess never blocks the
        /// single render thread that serializes all RPCs: the auto-discovery inside the following
        /// _sta.Invoke then hits the resolver cache. No-op when an explicit assembly path is supplied
        /// (that path is only File.Exists-checked on the STA side — no subprocess). Best-effort; any real
        /// resolution error surfaces on the STA path.
        /// </summary>
        private static void Prewarm(string designerFilePath, string? controlAssemblyPath)
        {
            if (!string.IsNullOrWhiteSpace(controlAssemblyPath)) return;
            // FIRE-AND-FORGET: warming the MSBuild cache must NEVER block (or hang) the render RPC. The
            // render resolves with allowEval:false (cache hit, else the fast bin-search) and stays
            // responsive; this populates the cache off-thread for subsequent renders. (Regression guard:
            // a synchronous eval here once hung "Rendering…" forever when a reused MSBuild node held the
            // redirect pipe — now both non-blocking AND node-reuse-disabled in RunGetProperty.)
            _ = Task.Run(() =>
            {
                try { ProjectResolver.ResolveOutputAssembly(designerFilePath); } catch { /* best effort */ }
            });
        }

        /// <summary>
        /// Resolve the auto-discovered control assembly for a .Designer.cs (MSBuild design-time eval →
        /// bin search), or null if none. Pure / off-STA; lets the host surface which assembly was chosen.
        /// </summary>
        public string? ResolveAssembly(string designerFilePath) =>
            ProjectResolver.ResolveOutputAssembly(designerFilePath);

        /// <summary>
        /// Render a .Designer.cs to PNG bytes (base64 over JSON-RPC). controlAssemblyPath is an optional
        /// explicit override for the control assembly; when null/blank the engine auto-discovers the
        /// project's build output (ProjectResolver). The override is the fallback for projects whose
        /// output the lightweight resolver can't find (multi-target, custom OutputPath, not-yet-built).
        /// </summary>
        public byte[] RenderDesigner(string designerFilePath, string? controlAssemblyPath = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.RenderToPng(designerFilePath, NullIfBlank(controlAssemblyPath)));
        }

        /// <summary>
        /// Render the full frame to PNG AND enumerate the click-to-select hit-test map in a SINGLE graph
        /// load — the combined RenderDesigner + DescribeLayout the unified designer's full render needs
        /// together. One LoadGraph instead of two (render and layout each re-parsed/-interpreted/-rebuilt
        /// the graph — the dominant cost on large forms). Png/Width/Height/Controls are identical to the two
        /// separate calls. controlAssemblyPath optionally overrides project auto-discovery (see
        /// <see cref="RenderDesigner"/>).
        /// </summary>
        public RenderLayoutResult RenderWithLayout(string designerFilePath, string? controlAssemblyPath = null, string? sourceText = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.RenderWithLayout(designerFilePath, NullIfBlank(controlAssemblyPath), sourceText));
        }

        /// <summary>
        /// Render a SINGLE control (by edit id, "this" = root) to PNG + placement — the engine half of
        /// dirty-region updates (S3): the host re-renders only the changed control (~0.3–1 ms) and
        /// composites the patch instead of a full frame. <see cref="ControlRenderResult.Found"/> is false
        /// when the id matches no control. controlAssemblyPath optionally overrides auto-discovery.
        /// </summary>
        public ControlRenderResult RenderControl(string designerFilePath, string componentId, string? controlAssemblyPath = null, string? sourceText = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.RenderControl(designerFilePath, componentId, NullIfBlank(controlAssemblyPath), sourceText));
        }

        /// <summary>
        /// Compute the would-be-saved file text (normalized InitializeComponent spliced into the
        /// source) WITHOUT writing — the host applies it as a WorkspaceEdit (plan §6.6, the engine
        /// never writes files itself). <see cref="SavePreview.Text"/> is null when the source is not
        /// safe to round-trip (read-only fallback, §6.5). controlAssemblyPath optionally overrides
        /// project auto-discovery (see <see cref="RenderDesigner"/>).
        /// </summary>
        public SavePreview PreviewSave(string designerFilePath, string? controlAssemblyPath = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() =>
        {
            var r = DesignerRenderer.SaveSplice(designerFilePath, NullIfBlank(controlAssemblyPath));
            return new SavePreview
            {
                Safe = r.Safe,
                Text = r.Safe ? r.SplicedText : null,
                Unrepresentable = r.RoundTrip.Unrepresentable.ToArray(),
                MissingStatements = r.MissingStatements.ToArray(),
            };
        });
        }

        /// <summary>
        /// Serialize a .Designer.cs back to a normalized InitializeComponent (§6.3) WITHOUT writing —
        /// the round-trip preview (the explicit-asm-aware RPC complement to the CLI --roundtrip).
        /// <see cref="SerializePreview.Code"/> is null when the source doesn't fully round-trip (§6.5).
        /// controlAssemblyPath optionally overrides project auto-discovery (see <see cref="RenderDesigner"/>).
        /// </summary>
        public SerializePreview SerializeDesigner(string designerFilePath, string? controlAssemblyPath = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() =>
            {
                var r = DesignerRenderer.SerializeFromFile(designerFilePath, NullIfBlank(controlAssemblyPath));
                return new SerializePreview
                {
                    Safe = r.RoundTripSafe,
                    Code = r.RoundTripSafe ? r.Code : null,
                    Unrepresentable = r.Unrepresentable.ToArray(),
                };
            });
        }

        /// <summary>
        /// Compute a targeted single-property edit WITHOUT writing (host applies as WorkspaceEdit).
        /// Byte-minimal: only the target property's value changes. <see cref="EditPreview.Text"/> is
        /// null when the edit is rejected (couldn't place, syntax error, or changed more than target).
        /// </summary>
        public EditPreview SetProperty(string designerFilePath, string componentName, string propertyName, string newValueExpr, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyPropertyEdit(designerFilePath, componentName, propertyName, newValueExpr, sourceText);
            return new EditPreview { Safe = r.Safe, Mode = r.Mode.ToString(), Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Enumerate the form's controls and their properties (read side for a property grid).
        /// controlAssemblyPath optionally overrides project auto-discovery (see <see cref="RenderDesigner"/>).</summary>
        public DescribeResult DescribeDesigner(string designerFilePath, string? controlAssemblyPath = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.Describe(designerFilePath, NullIfBlank(controlAssemblyPath)));
        }

        /// <summary>Describe one component by edit id ("this" = root) — bounded per-selection fetch for a grid.
        /// controlAssemblyPath optionally overrides project auto-discovery (see <see cref="RenderDesigner"/>).</summary>
        public ComponentInfo? DescribeComponent(string designerFilePath, string componentId, string? controlAssemblyPath = null, string? sourceText = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.DescribeComponent(designerFilePath, componentId, NullIfBlank(controlAssemblyPath), sourceText));
        }

        /// <summary>
        /// Enumerate every control's window-space bounds (+ tree info) — the read side for click-to-select
        /// in the unified designer view: the host maps a click pixel to a component id by hit-testing these
        /// rectangles (returned innermost-first). Bounds share <see cref="RenderControl"/>'s transform so a
        /// selection rectangle and a dirty-region patch align. controlAssemblyPath optionally overrides
        /// project auto-discovery (see <see cref="RenderDesigner"/>).
        /// </summary>
        public LayoutResult DescribeLayout(string designerFilePath, string? controlAssemblyPath = null, string? sourceText = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.DescribeLayout(designerFilePath, NullIfBlank(controlAssemblyPath), sourceText));
        }

        /// <summary>
        /// VS-style "create event handler": add the event wiring to InitializeComponent (.Designer.cs) and an
        /// empty handler stub to the code-behind (.cs). The host applies both returned texts as unsaved edits
        /// and navigates into the stub. designerSourceText/codeText are the unsaved buffers (null → disk / no
        /// code edit); handlerName overrides the default comp_Event name. Loads the graph (STA) only to
        /// reflect the delegate signature. controlAssemblyPath optionally overrides project auto-discovery.
        /// </summary>
        public EventGenResult GenerateEventHandler(string designerFilePath, string componentId, string eventName,
            string? handlerName = null, string? designerSourceText = null, string? codeText = null, string? controlAssemblyPath = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.GenerateEventHandler(
                designerFilePath, componentId, eventName,
                NullIfBlank(handlerName), designerSourceText, codeText, NullIfBlank(controlAssemblyPath)));
        }

        /// <summary>Events dropdown: existing code-behind methods compatible with each of a component's events
        /// (eventName → candidate method names). designerSourceText/codeText are the unsaved buffers.</summary>
        public List<EventCandidates> ListHandlerCandidates(string designerFilePath, string componentId,
            string? designerSourceText = null, string? codeText = null, string? controlAssemblyPath = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.ListHandlerCandidates(designerFilePath, componentId, designerSourceText, codeText, NullIfBlank(controlAssemblyPath)));
        }

        /// <summary>Events dropdown write path: wire/rewire/unwire an event to an EXISTING handler. handlerName
        /// null/blank → unwire. Edits only the .Designer.cs; the host applies the returned text as an unsaved
        /// edit. codeText (the code-behind buffer) lets the engine refuse wiring to a non-existent method.</summary>
        public EventWiringResult SetEventWiring(string designerFilePath, string componentId, string eventName,
            string? handlerName = null, string? designerSourceText = null, string? codeText = null, string? controlAssemblyPath = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.SetEventWiring(designerFilePath, componentId, eventName, NullIfBlank(handlerName), designerSourceText, codeText, NullIfBlank(controlAssemblyPath)));
        }

        /// <summary>Toolbox add-control: insert a standard WinForms control (field decl + InitializeComponent
        /// statements) as a text edit. PURE TEXT — no graph load / STA (the generated statements are
        /// interpreted on the next render). The host applies the returned text as an unsaved edit.</summary>
        public ControlAddResult AddControl(string designerFilePath, string parentId, string controlTypeKey, string? sourceText = null, int? locX = null, int? locY = null, string? controlAssemblyPath = null)
        {
            Prewarm(designerFilePath, controlAssemblyPath); // a project-control key (§7.2 Inc2) needs the resolved assembly
            return DesignerRenderer.AddControl(designerFilePath, parentId, controlTypeKey, sourceText, locX, locY, NullIfBlank(controlAssemblyPath));
        }

        /// <summary>The toolbox's available control type keys (e.g. "Button", "Label", …).</summary>
        public List<string> ListControlTypes() => DesignerRenderer.ControlTypes().ToList();

        /// <summary>The auto-populated toolbox palette (§7.2): framework controls always, plus the resolved
        /// project assembly's own controls (§7.2 Increment 2, "Project Controls") when a designer file is given.
        /// Framework discovery is pure reflection; project enumeration loads the assembly in a collectible ALC.</summary>
        public List<ToolboxItemInfo> ListToolboxItems(string? designerFilePath = null, string? controlAssemblyPath = null)
        {
            if (!string.IsNullOrEmpty(designerFilePath)) Prewarm(designerFilePath, controlAssemblyPath);
            return DesignerRenderer.ToolboxItems(NullIfBlank(designerFilePath), NullIfBlank(controlAssemblyPath)).ToList();
        }

        /// <summary>The "Choose Toolbox Items" dialog rows (richer LISTING view): framework Controls+Components +
        /// the project assembly's types + an optional browsed .dll. Pure reflection (collectible ALC for the
        /// project/browsed assemblies); never reaches AddControl's gate.</summary>
        public List<ToolboxCandidate> ListToolboxCandidates(string? designerFilePath = null, string? controlAssemblyPath = null, List<string>? browseAssemblyPaths = null)
        {
            if (!string.IsNullOrEmpty(designerFilePath)) Prewarm(designerFilePath, controlAssemblyPath);
            return DesignerRenderer.ToolboxCandidates(NullIfBlank(designerFilePath), NullIfBlank(controlAssemblyPath), browseAssemblyPaths);
        }

        /// <summary>Scan ONE browsed .dll for toolbox-eligible types (the Choose-Items "Browse…" path), returning
        /// the found rows plus a human-readable reason when nothing usable was found (so the dialog gives feedback
        /// instead of silently doing nothing). Pure reflection in a collectible ALC; never instantiates.</summary>
        public ToolboxScanResult ScanToolboxAssembly(string assemblyPath) =>
            DesignerRenderer.ScanAssemblyCandidates(assemblyPath, false);

        /// <summary>Remove a leaf control (field decl + its InitializeComponent statements) as a text edit.
        /// PURE TEXT — no graph load/STA. Refuses a container with children / externally-referenced control.</summary>
        public ControlRemoveResult RemoveControl(string designerFilePath, string controlId, string? sourceText = null) =>
            DesignerRenderer.RemoveControl(designerFilePath, controlId, sourceText);

        /// <summary>Copy a leaf control to an opaque clipboard blob (field type + InitializeComponent statements).
        /// PURE TEXT — no graph load/STA. The host stores the blob and hands it back to <see cref="PasteControl"/>.</summary>
        public ControlCopyResult CopyControl(string designerFilePath, string controlId, string? sourceText = null) =>
            DesignerRenderer.CopyControl(designerFilePath, controlId, sourceText);

        /// <summary>Paste a clipboard blob (from <see cref="CopyControl"/>) into a container as a fresh control.
        /// PURE TEXT — no graph load/STA. The host applies the returned text as an unsaved edit.</summary>
        public ControlPasteResult PasteControl(string designerFilePath, string clip, string parentId, string? sourceText = null) =>
            DesignerRenderer.PasteControl(designerFilePath, clip, parentId, sourceText);

        /// <summary>Bring a control to front / send it to back by relocating its Controls.Add among its siblings.
        /// PURE TEXT — no graph load/STA. The host applies the returned text as an unsaved edit.</summary>
        public ControlReorderResult MoveZOrder(string designerFilePath, string controlId, bool toFront, string? sourceText = null) =>
            DesignerRenderer.MoveZOrder(designerFilePath, controlId, toFront, sourceText);

        /// <summary>
        /// Build a C# initializer expression for a complex framework property value (Point/Size/Color/…)
        /// from its invariant-string form, so the grid can edit types it otherwise shows read-only.
        /// Returns null when the value isn't convertible (caller leaves the property read-only / rejects).
        /// Pure TypeConverter/CodeDom work with no UI-thread affinity, so it runs directly on the RPC
        /// thread (like SetProperty) rather than serializing behind renders on the single STA thread.
        /// </summary>
        public string? ConvertValue(string typeName, string invariantValue) =>
            DesignerValueConverter.ToExpression(typeName, invariantValue);
    }

    /// <summary>DTO for the no-write save preview RPC.</summary>
    public sealed class SavePreview
    {
        public bool Safe { get; set; }
        public string? Text { get; set; }
        public string[] Unrepresentable { get; set; } = Array.Empty<string>();
        public string[] MissingStatements { get; set; } = Array.Empty<string>();
    }

    /// <summary>DTO for the no-write serialize (round-trip) preview RPC.</summary>
    public sealed class SerializePreview
    {
        public bool Safe { get; set; }
        public string? Code { get; set; }
        public string[] Unrepresentable { get; set; } = Array.Empty<string>();
    }

    /// <summary>DTO for the no-write targeted property-edit RPC.</summary>
    public sealed class EditPreview
    {
        public bool Safe { get; set; }
        public string Mode { get; set; } = "";
        public string? Text { get; set; }
        public string Reason { get; set; } = "";
    }

    /// <summary>Runs all WinForms/design-surface work on one persistent STA thread.</summary>
    public sealed class StaDispatcher
    {
        private readonly BlockingCollection<Action> _queue = new();

        public StaDispatcher()
        {
            var t = new Thread(Loop) { IsBackground = true, Name = "winforms-sta" };
            t.SetApartmentState(ApartmentState.STA);
            t.Start();
        }

        private void Loop()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            foreach (var action in _queue.GetConsumingEnumerable())
            {
                action();
            }
        }

        public T Invoke<T>(Func<T> func)
        {
            T result = default!;
            Exception? error = null;
            using var done = new ManualResetEventSlim(false);
            _queue.Add(() =>
            {
                try { result = func(); }
                catch (Exception ex) { error = ex; }
                finally { done.Set(); }
            });
            done.Wait();
            if (error != null)
            {
                throw new InvalidOperationException("render failed: " + error.Message, error);
            }
            return result;
        }
    }
}
