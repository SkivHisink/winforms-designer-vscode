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

            if (Has(args, "--coverage-report", out string? covDir) && covDir != null)
            {
                // M6 fallback-rate gate mechanism: measure the SOURCE-COVERAGE interpreted-vs-fallback rate over a
                // corpus of .Designer.cs files. Coverage (does the closed IR fully represent InitializeComponent?) is
                // the dominant, engine-agnostic driver of the interpreted-vs-compiledFallback decision, and it is a
                // pure source-parse property — no compiled assembly needed. (Runtime fallbacks — a real vendor ctor
                // that throws, a base changed since the last build — need the actual build and are measured separately
                // against the user's corpus.) Usage: engine --coverage-report <dir> [--min-rate <pct>]; a non-zero exit
                // when the interpreted rate is below --min-rate makes this a CI/release gate against a chosen corpus.
                double minRate = double.TryParse(ArgAfter(args, "--min-rate"), System.Globalization.NumberStyles.Float,
                    System.Globalization.CultureInfo.InvariantCulture, out var mr) ? mr : -1;
                int total = 0, interp = 0;
                var reasons = new Dictionary<string, int>(StringComparer.Ordinal);
                var fellBack = new List<string>();
                IEnumerable<string> files;
                try { files = Directory.EnumerateFiles(covDir, "*.Designer.cs", SearchOption.AllDirectories); }
                catch (Exception ex) { Console.WriteLine("RESULT: FAIL — cannot enumerate '" + covDir + "': " + ex.Message); return 1; }
                foreach (var f in files.OrderBy(x => x, StringComparer.Ordinal))
                {
                    total++;
                    string reason;
                    try
                    {
                        var doc = DesignerIrBuilder.Build(File.ReadAllText(f));
                        var decision = RenderModeClassifier.FromCoverage(doc);
                        if (decision.Mode == RenderMode.Interpreted) { interp++; continue; }
                        reason = decision.FallbackReason ?? "unknown";
                    }
                    catch (Exception ex) { reason = "parseError:" + ex.GetType().Name; }
                    reasons[reason] = reasons.TryGetValue(reason, out var c) ? c + 1 : 1;
                    fellBack.Add(Path.GetFileName(f) + "  (" + reason + ")");
                }
                int fb = total - interp;
                double rate = total == 0 ? 0 : 100.0 * interp / total;
                var inv = System.Globalization.CultureInfo.InvariantCulture;
                Console.WriteLine("== coverage report (source-coverage interpreted-vs-fallback) over " + covDir);
                Console.WriteLine("   runtime     : " + RuntimeInformation.FrameworkDescription);
                Console.WriteLine("   forms       : " + total);
                Console.WriteLine("   interpreted : " + interp);
                Console.WriteLine("   fallback    : " + fb);
                Console.WriteLine("   rate        : " + rate.ToString("F1", inv) + "% interpreted");
                if (fellBack.Count > 0)
                {
                    Console.WriteLine("   fallback reasons:");
                    foreach (var kv in reasons.OrderByDescending(k => k.Value)) Console.WriteLine("       " + kv.Value + "x  " + kv.Key);
                    Console.WriteLine("   fallback forms:");
                    foreach (var s in fellBack) Console.WriteLine("       - " + s);
                }
                Console.WriteLine("COVERAGE_JSON {\"total\":" + total + ",\"interpreted\":" + interp + ",\"fallback\":" + fb
                    + ",\"rate\":" + rate.ToString("F2", inv) + "}");
                if (minRate >= 0 && rate < minRate)
                {
                    Console.WriteLine("RESULT: FAIL — interpreted rate " + rate.ToString("F1", inv) + "% < required " + minRate.ToString("F1", inv) + "%");
                    return 1;
                }
                Console.WriteLine("RESULT: PASS");
                return 0;
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
                    Console.WriteLine("== engine roundtrip (load -> serialize, normalization)");
                    Console.WriteLine("   runtime        : " + RuntimeInformation.FrameworkDescription);
                    Console.WriteLine("   class          : " + res.ClassName);
                    Console.WriteLine("   statements     : " + res.TotalStatements + " (representable " + res.Representable + ")");
                    Console.WriteLine("   render-safe (RoundTripSafe): " + res.RoundTripSafe + " (unrepresentable " + res.Unrepresentable.Count + ")");
                    foreach (var u in res.Unrepresentable) Console.WriteLine("       ! " + u);
                    Console.WriteLine("   over-emit removed: " + res.DefaultsDropped);
                    foreach (var d in res.DroppedDefaults) Console.WriteLine("       - " + d);

                    // diagnostic only (NOT a pass gate): for the default-free fixtures, confirm the
                    // spurious defaults are gone. Explicit-mode legitimately keeps a source-explicit
                    // Enabled=true/Visible=true, so raw-string absence must not gate pass/fail.
                    Console.WriteLine("   no spurious Enabled=true: " + !res.Code.Contains(".Enabled = true")
                                      + " | Visible=true: " + !res.Code.Contains(".Visible = true"));

                    // AUTHORITATIVE save-safe gate (capability preflight). RoundTripSafe above is render-only and
                    // over-optimistic: a form can render fully yet lose statements on re-serialization (a Hidden
                    // component-ref, TabPages.AddRange, TreeNode locals). The verdict a regenerate must trust is
                    // "renders AND no original statement is lost" — mirror DesignerRenderer.SaveSplice's gate here so
                    // --roundtrip and --save agree instead of --roundtrip reporting a misleading "PASS".
                    var rtMissing = res.RoundTripSafe
                        ? DesignerSaveSplicer.MissingOriginalStatements(File.ReadAllText(rtFile), res.Code)
                        : new List<string>();
                    if (rtMissing.Count > 0)
                    {
                        Console.WriteLine("   statements lost by re-serialization: " + rtMissing.Count);
                        foreach (var m in rtMissing) Console.WriteLine("       ? " + m);
                    }
                    bool saveSafe = res.RoundTripSafe && rtMissing.Count == 0;
                    Console.WriteLine("   save-safe (authoritative): " + saveSafe
                        + " | capability: " + SaveSafety.CategoryName(SaveSafety.Classify(res.Unrepresentable, rtMissing)));

                    if (saveSafe)
                    {
                        if (outCs != null)
                        {
                            // --out writes the NORMALIZED whole-file serializer artifact (namespace WinFormsDesigner.Generated),
                            // NOT splice-safe source — it is a diagnostic dump, never a write-back. Refuse to point it at the
                            // input (or its sibling .cs), which would replace the real namespace / partial / Dispose / comments
                            // with the artifact. The safe whole-file writer is --save (it splices, preserving structure).
                            // --out writes a normalized diagnostic dump, NOT splice-safe source. Refuse if the target
                            // (or its ".raw.cs" sibling) already EXISTS — a fresh path can't alias the source, whereas a
                            // string-equality check misses a hard-link/symlink alias of the input.
                            // --out is diagnostic-only (the product writes via --save / the RPCs), so requiring a fresh
                            // path is the fail-closed choice.
                            if (File.Exists(outCs) || File.Exists(outCs + ".raw.cs"))
                            {
                                Console.WriteLine("REFUSED: --out (and its .raw.cs sibling) must be a fresh path — a normalized diagnostic dump, never an overwrite (could alias the source via a hard/symlink); use --save to write.");
                                return 2;
                            }
                            File.WriteAllText(outCs, res.Code);
                            File.WriteAllText(outCs + ".raw.cs", res.RawCode);
                            Console.WriteLine("   wrote          : " + outCs + " (+ .raw.cs)");
                        }
                    }
                    else
                    {
                        // never overwrite the source with a lossy result — skip --out entirely
                        Console.WriteLine("WARNING: source not save-safe (read-only fallback); --out skipped");
                    }
                    Console.WriteLine();
                    Console.WriteLine("--- normalized InitializeComponent ---");
                    Console.WriteLine(res.Code);
                    Console.WriteLine(saveSafe ? "RESULT: PASS" : "RESULT: FAIL");
                    return saveSafe ? 0 : 1;
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
                        Console.WriteLine("   statements lost by re-serialization: " + res.MissingStatements.Count);
                        foreach (var m in res.MissingStatements) Console.WriteLine("       ? " + m);
                    }
                    Console.WriteLine("   capability     : " + SaveSafety.CategoryName(
                        SaveSafety.Classify(res.RoundTrip.Unrepresentable, res.MissingStatements)));

                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: source not safe to round-trip — refusing to write (read-only fallback)");
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }

                    if (write)
                    {
                        // transactional write: hard pre-save backup (byte copy), then overwrite in the original encoding
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
                        // properties offering a dropdown (TypeConverter standard values) — incl. ImageIndex/ImageKey when
                        // an ImageList is attached, enum/bool/Cursor/Color sets, etc.
                        foreach (var p in c.Properties.Where(p => p.StandardValues != null && p.StandardValues.Count > 0))
                        {
                            Console.WriteLine("       [dropdown] " + p.Name + (p.StandardValuesExclusive ? " (exclusive)" : "") + ": " + string.Join(", ", p.StandardValues!)); // non-null: filtered above
                        }
                        // 0.11.0 minimal (Collection) routing — surface the editable collections the grid shows: the
                        // bespoke-edited ones (IsCollection, "…" editor) and the read-only "(Collection)" placeholders.
                        foreach (var p in c.Properties.Where(p => p.IsCollection || p.Value == "(Collection)"))
                        {
                            Console.WriteLine("       [collection] " + p.Name + (p.IsCollection ? " (editable, item=" + (p.CollectionItemType ?? "?") + ")" : " (Collection) read-only"));
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

            if (Has(args, "--set-modifier", out string? smFile) && smFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                string? mod = ArgAfter(args, "--mod");
                bool write = Has(args, "--write", out _);
                if (comp.Length == 0 || mod == null)
                {
                    Console.WriteLine("usage: --set-modifier <file> --comp <fieldName> --mod <Public|Private|Protected|Internal|Protected Internal|Private Protected> [--write]");
                    return 2;
                }
                try
                {
                    // read with BOM/encoding detection so --write round-trips the original encoding (a
                    // File.ReadAllText + default-UTF-8 write would rewrite a UTF-16/BOM source outside the token).
                    var (enc, src) = DesignerRenderer.ReadWithEncoding(smFile);
                    var res = DesignerModifiers.SetModifier(src, comp, mod);
                    Console.WriteLine("== engine set-modifier (byte-local field-declaration access keyword)");
                    Console.WriteLine("   target : " + comp + " -> " + mod);
                    Console.WriteLine("   reason : " + res.Reason);
                    if (!res.Safe || res.Text == null)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        string bak = smFile + ".bak";
                        File.Copy(smFile, bak, overwrite: true);
                        File.WriteAllText(smFile, res.Text, enc);
                        Console.WriteLine("   APPLIED: wrote " + smFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        string preview = smFile + ".modifier.txt";
                        File.WriteAllText(preview, res.Text, enc);
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

            if (Has(args, "--reset-prop", out string? rpFile) && rpFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "this";
                string? prop = ArgAfter(args, "--prop");
                if (prop == null)
                {
                    Console.WriteLine("usage: --reset-prop <file> [--comp <name>] --prop <name>");
                    return 2;
                }
                try
                {
                    var res = DesignerRenderer.ApplyPropertyReset(rpFile, comp, prop);
                    Console.WriteLine("== engine reset-property (delete the assignment → default)");
                    Console.WriteLine("   target : " + comp + "." + prop);
                    Console.WriteLine("   ok: " + res.Ok + " | changed: " + res.Changed + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Ok)
                    {
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    Console.WriteLine("RESULT: PASS" + (res.Changed ? " (assignment removed)" : " (no-op — already default)"));
                    return 0;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--list-collection", out string? lcFile) && lcFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "this";
                string? prop = ArgAfter(args, "--prop");
                if (prop == null)
                {
                    Console.WriteLine("usage: --list-collection <file> --comp <id> --prop <name>");
                    return 2;
                }
                try
                {
                    var res = DesignerRenderer.ListCollectionItems(lcFile, comp, prop);
                    Console.WriteLine("== engine list-collection (string items of " + comp + "." + prop + ")");
                    Console.WriteLine("   ok: " + res.Ok + " | count: " + res.Items.Count + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    for (int i = 0; i < res.Items.Count; i++) Console.WriteLine("   [" + i + "] " + res.Items[i]);
                    Console.WriteLine("RESULT: " + (res.Ok ? "PASS" : "FAIL"));
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--set-collection", out string? scFile) && scFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "this";
                string? prop = ArgAfter(args, "--prop");
                bool write = Has(args, "--write", out _);
                // repeated --item <value> (may be zero → clears the collection); mirrors --proj-fqn collection
                var items = args.Select((a, i) => (a, i)).Where(x => x.a == "--item" && x.i + 1 < args.Length).Select(x => args[x.i + 1]).ToList();
                if (prop == null)
                {
                    Console.WriteLine("usage: --set-collection <file> --comp <id> --prop <name> [--item <v>]... [--write]");
                    return 2;
                }
                try
                {
                    var res = DesignerRenderer.ApplyCollectionEdit(scFile, comp, prop, items);
                    Console.WriteLine("== engine set-collection (rewrite " + comp + "." + prop + " to " + items.Count + " items)");
                    Console.WriteLine("   mode: " + res.Mode + " | parse-ok: " + res.ParseOk + " | minimal: " + res.Minimal + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        string bak = scFile + ".bak";
                        File.Copy(scFile, bak, overwrite: true);
                        File.WriteAllText(scFile, res.NewText!, res.Encoding);
                        Console.WriteLine("   APPLIED: wrote " + scFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        string preview = scFile + ".edited.txt";
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

            if (Has(args, "--list-lines", out string? llFile) && llFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "this";
                string? prop = ArgAfter(args, "--prop") ?? "Lines";
                try
                {
                    var res = DesignerRenderer.ListStringArray(llFile, comp, prop);
                    Console.WriteLine("== engine list-lines (string[] items of " + comp + "." + prop + ")");
                    Console.WriteLine("   ok: " + res.Ok + " | count: " + res.Items.Count + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    for (int i = 0; i < res.Items.Count; i++) Console.WriteLine("   [" + i + "] " + res.Items[i]);
                    Console.WriteLine("RESULT: " + (res.Ok ? "PASS" : "FAIL"));
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--set-lines", out string? slFile) && slFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "this";
                string prop = ArgAfter(args, "--prop") ?? "Lines";
                bool write = Has(args, "--write", out _);
                // repeated --item <value> (may be zero → clears to an empty array); mirrors --set-collection
                var items = args.Select((a, i) => (a, i)).Where(x => x.a == "--item" && x.i + 1 < args.Length).Select(x => args[x.i + 1]).ToList();
                try
                {
                    var res = DesignerRenderer.ApplyStringArrayEdit(slFile, comp, prop, items);
                    Console.WriteLine("== engine set-lines (rewrite " + comp + "." + prop + " to string[" + items.Count + "])");
                    Console.WriteLine("   mode: " + res.Mode + " | parse-ok: " + res.ParseOk + " | minimal: " + res.Minimal + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        string bak = slFile + ".bak";
                        File.Copy(slFile, bak, overwrite: true);
                        File.WriteAllText(slFile, res.NewText!, res.Encoding);
                        Console.WriteLine("   APPLIED: wrote " + slFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        string preview = slFile + ".edited.txt";
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

            if (Has(args, "--list-columns", out string? lcolFile) && lcolFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                try
                {
                    var res = DesignerRenderer.ListColumnItems(lcolFile, comp);
                    Console.WriteLine("== engine list-columns (ListView " + comp + ".Columns)");
                    Console.WriteLine("   ok: " + res.Ok + " | count: " + res.Columns.Count + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    for (int i = 0; i < res.Columns.Count; i++)
                    {
                        var c = res.Columns[i];
                        Console.WriteLine("   [" + i + "] id=" + c.Id + " text=\"" + c.Text + "\" width=" + c.Width + " align=" + c.TextAlign);
                    }
                    Console.WriteLine("RESULT: " + (res.Ok ? "PASS" : "FAIL"));
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--set-columns", out string? scolFile) && scolFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                bool write = Has(args, "--write", out _);
                // repeated --col "id|text|width|align" (empty id = a new column; may be zero → clears the collection)
                var cols = args.Select((a, i) => (a, i))
                    .Where(x => x.a == "--col" && x.i + 1 < args.Length)
                    .Select(x =>
                    {
                        var parts = args[x.i + 1].Split('|');
                        int w = 60;
                        if (parts.Length > 2) int.TryParse(parts[2], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out w);
                        return new ColumnItem
                        {
                            Id = parts.Length > 0 ? parts[0] : "",
                            Text = parts.Length > 1 ? parts[1] : "",
                            Width = w,
                            TextAlign = parts.Length > 3 && parts[3].Length > 0 ? parts[3] : "Left",
                        };
                    }).ToArray();
                try
                {
                    var res = DesignerRenderer.ApplyColumnsEdit(scolFile, comp, cols);
                    Console.WriteLine("== engine set-columns (rewrite " + comp + ".Columns to " + cols.Length + " columns)");
                    Console.WriteLine("   mode: " + res.Mode + " | parse-ok: " + res.ParseOk + " | minimal: " + res.Minimal + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        string bak = scolFile + ".bak";
                        File.Copy(scolFile, bak, overwrite: true);
                        File.WriteAllText(scolFile, res.NewText!, res.Encoding);
                        Console.WriteLine("   APPLIED: wrote " + scolFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        string preview = scolFile + ".edited.txt";
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

            if (Has(args, "--list-nodes", out string? lnFile) && lnFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                try
                {
                    var res = DesignerRenderer.ListNodeItems(lnFile, comp);
                    Console.WriteLine("== engine list-nodes (TreeView " + comp + ".Nodes)");
                    Console.WriteLine("   ok: " + res.Ok + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    void Print(System.Collections.Generic.IReadOnlyList<TreeNodeItem> ns, int depth)
                    {
                        foreach (var n in ns)
                        {
                            Console.WriteLine("   " + new string(' ', depth * 2) + "- id=" + n.Id + " text=\"" + n.Text + "\" name=\"" + n.Name + "\" imgKey=\"" + n.ImageKey + "\" imgIdx=" + n.ImageIndex + " selKey=\"" + n.SelectedImageKey + "\" selIdx=" + n.SelectedImageIndex + " tip=\"" + n.ToolTipText + "\" checked=" + n.Checked + " fore=\"" + n.ForeColor + "\" back=\"" + n.BackColor + "\" font=\"" + n.NodeFont + "\"");
                            Print(n.Children, depth + 1);
                        }
                    }
                    Print(res.Nodes, 0);
                    Console.WriteLine("RESULT: " + (res.Ok ? "PASS" : "FAIL"));
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--set-nodes", out string? snFile) && snFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                bool write = Has(args, "--write", out _);
                // repeated --node "depth|id|text|name|imageKey|imageIndex|selImageKey|selImageIndex|toolTip|checked|foreColor|backColor|nodeFont"
                // (all fields past name optional; empty id = a new node; depth 0 = root; may be zero → clears).
                // fore/back/font are invariant strings ("Red" / "64, 128, 255" / "Segoe UI, 9pt, style=Bold").
                var flat = args.Select((a, i) => (a, i))
                    .Where(x => x.a == "--node" && x.i + 1 < args.Length)
                    .Select(x =>
                    {
                        var p = args[x.i + 1].Split('|');
                        int depth = 0;
                        if (p.Length > 0) int.TryParse(p[0], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out depth);
                        int ImgIdx(int k) => p.Length > k && int.TryParse(p[k], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : -1;
                        return (depth, node: new TreeNodeItem
                        {
                            Id = p.Length > 1 ? p[1] : "",
                            Text = p.Length > 2 ? p[2] : "",
                            Name = p.Length > 3 ? p[3] : "",
                            ImageKey = p.Length > 4 ? p[4] : "",
                            ImageIndex = ImgIdx(5),
                            SelectedImageKey = p.Length > 6 ? p[6] : "",
                            SelectedImageIndex = ImgIdx(7),
                            ToolTipText = p.Length > 8 ? p[8] : "",
                            Checked = p.Length > 9 && p[9] == "true",
                            ForeColor = p.Length > 10 ? p[10] : "",
                            BackColor = p.Length > 11 ? p[11] : "",
                            NodeFont = p.Length > 12 ? p[12] : "",
                        });
                    }).ToList();
                var roots = new System.Collections.Generic.List<TreeNodeItem>();
                var stack = new System.Collections.Generic.List<(int depth, TreeNodeItem node)>();
                foreach (var (depth, node) in flat)
                {
                    while (stack.Count > 0 && stack[stack.Count - 1].depth >= depth) stack.RemoveAt(stack.Count - 1);
                    if (stack.Count == 0) roots.Add(node); else stack[stack.Count - 1].node.Children.Add(node);
                    stack.Add((depth, node));
                }
                try
                {
                    var res = DesignerRenderer.ApplyNodesEdit(snFile, comp, roots);
                    Console.WriteLine("== engine set-nodes (rewrite " + comp + ".Nodes; " + flat.Count + " node(s))");
                    Console.WriteLine("   mode: " + res.Mode + " | parse-ok: " + res.ParseOk + " | minimal: " + res.Minimal + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        string bak = snFile + ".bak";
                        File.Copy(snFile, bak, overwrite: true);
                        File.WriteAllText(snFile, res.NewText!, res.Encoding);
                        Console.WriteLine("   APPLIED: wrote " + snFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        string preview = snFile + ".edited.txt";
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

            if (Has(args, "--list-tsitems", out string? ltFile) && ltFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                try
                {
                    var res = DesignerRenderer.ListToolStripItems(ltFile, comp);
                    Console.WriteLine("== engine list-tsitems (ToolStrip/MenuStrip " + comp + ".Items)");
                    Console.WriteLine("   ok: " + res.Ok + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    void PrintTs(System.Collections.Generic.IReadOnlyList<ToolStripItemModel> its, int depth)
                    {
                        foreach (var it in its)
                        {
                            Console.WriteLine("   " + new string(' ', depth * 2) + "- id=" + it.Id + " type=" + it.ItemType + " text=\"" + it.Text + "\" name=\"" + it.Name + "\"");
                            PrintTs(it.Children, depth + 1);
                        }
                    }
                    PrintTs(res.Items, 0);
                    Console.WriteLine("RESULT: " + (res.Ok ? "PASS" : "FAIL"));
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--set-tsitems", out string? stFile) && stFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                bool write = Has(args, "--write", out _);
                // repeated --tsitem "depth|id[|text[|itemType]]" — depth 0 = a top-level item, deeper = a DropDownItems
                // child of the previous shallower item. Reorder: give the existing field id. ADD ("Type Here"): leave id
                // EMPTY and give a text (and optional itemType, default ToolStripMenuItem), e.g. --tsitem "0||Help".
                // REMOVE: simply OMIT an existing item (and its subtree) from the --tsitem list — it is deleted.
                // RENAME: give an EXISTING id a new non-empty text, e.g. --tsitem "0|fileToolStripMenuItem|Datei".
                var flat = args.Select((a, i) => (a, i))
                    .Where(x => x.a == "--tsitem" && x.i + 1 < args.Length)
                    .Select(x =>
                    {
                        var p = args[x.i + 1].Split('|');
                        int depth = 0;
                        if (p.Length > 0) int.TryParse(p[0], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out depth);
                        return (depth, node: new ToolStripItemModel
                        {
                            Id = p.Length > 1 ? p[1] : "",
                            Text = p.Length > 2 ? p[2] : "",
                            ItemType = p.Length > 3 ? p[3] : "",
                        });
                    }).ToList();
                var roots = new System.Collections.Generic.List<ToolStripItemModel>();
                var stack = new System.Collections.Generic.List<(int depth, ToolStripItemModel node)>();
                foreach (var (depth, node) in flat)
                {
                    while (stack.Count > 0 && stack[stack.Count - 1].depth >= depth) stack.RemoveAt(stack.Count - 1);
                    if (stack.Count == 0) roots.Add(node); else stack[stack.Count - 1].node.Children.Add(node);
                    stack.Add((depth, node));
                }
                try
                {
                    var res = DesignerRenderer.ApplyToolStripItemsEdit(stFile, comp, roots);
                    Console.WriteLine("== engine set-tsitems (reorder/add/remove " + comp + ".Items; " + flat.Count + " item(s))");
                    Console.WriteLine("   mode: " + res.Mode + " | parse-ok: " + res.ParseOk + " | minimal: " + res.Minimal + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        string bak = stFile + ".bak";
                        File.Copy(stFile, bak, overwrite: true);
                        File.WriteAllText(stFile, res.NewText!, res.Encoding);
                        Console.WriteLine("   APPLIED: wrote " + stFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        string preview = stFile + ".edited.txt";
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

            if (Has(args, "--list-gridcolumns", out string? lgFile) && lgFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                try
                {
                    var res = DesignerRenderer.ListGridColumnItems(lgFile, comp);
                    Console.WriteLine("== engine list-gridcolumns (DataGridView " + comp + ".Columns)");
                    Console.WriteLine("   ok: " + res.Ok + " | count: " + res.Columns.Count + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    for (int i = 0; i < res.Columns.Count; i++)
                    {
                        var c = res.Columns[i];
                        Console.WriteLine("   [" + i + "] id=" + c.Id + " header=\"" + c.HeaderText + "\" width=" + c.Width + " readonly=" + c.ReadOnly + " visible=" + c.Visible);
                    }
                    Console.WriteLine("RESULT: " + (res.Ok ? "PASS" : "FAIL"));
                    return res.Ok ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--set-gridcolumns", out string? sgFile) && sgFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "";
                bool write = Has(args, "--write", out _);
                // repeated --col "id|header|width|readonly|visible" (empty id = new; zero --col = clear)
                var cols = args.Select((a, i) => (a, i))
                    .Where(x => x.a == "--col" && x.i + 1 < args.Length)
                    .Select(x =>
                    {
                        var parts = args[x.i + 1].Split('|');
                        int w = 100;
                        if (parts.Length > 2) int.TryParse(parts[2], System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out w);
                        return new GridColumnItem
                        {
                            Id = parts.Length > 0 ? parts[0] : "",
                            HeaderText = parts.Length > 1 ? parts[1] : "",
                            Width = w,
                            ReadOnly = parts.Length > 3 && parts[3] == "true",
                            Visible = !(parts.Length > 4 && parts[4] == "false"),
                        };
                    }).ToArray();
                try
                {
                    var res = DesignerRenderer.ApplyGridColumnsEdit(sgFile, comp, cols);
                    Console.WriteLine("== engine set-gridcolumns (rewrite " + comp + ".Columns to " + cols.Length + " columns)");
                    Console.WriteLine("   mode: " + res.Mode + " | parse-ok: " + res.ParseOk + " | minimal: " + res.Minimal + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Safe)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        string bak = sgFile + ".bak";
                        File.Copy(sgFile, bak, overwrite: true);
                        File.WriteAllText(sgFile, res.NewText!, res.Encoding);
                        Console.WriteLine("   APPLIED: wrote " + sgFile + " (backup: " + bak + ")");
                    }
                    else
                    {
                        string preview = sgFile + ".edited.txt";
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

            if (Has(args, "--deltab", out string? dtFile) && dtFile != null)
            {
                string host = ArgAfter(args, "--host") ?? "this";
                string? page = ArgAfter(args, "--page");
                if (page == null)
                {
                    Console.WriteLine("usage: --deltab <file> --host <tabHost> --page <tabPage>");
                    return 2;
                }
                try
                {
                    string src = System.IO.File.ReadAllText(dtFile);
                    var res = DesignerRenderer.RemoveTabPage(dtFile, host, page, src); // sourceText override → never writes disk
                    Console.WriteLine("== engine delete-tab (remove page + its whole subtree, detach from host)");
                    Console.WriteLine("   target : " + host + " / " + page);
                    Console.WriteLine("   safe: " + res.Safe + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Safe || res.NewText == null)
                    {
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    bool refGone = !System.Text.RegularExpressions.Regex.IsMatch(res.NewText, @"\bthis\." + System.Text.RegularExpressions.Regex.Escape(page) + @"\b");
                    int before = src.Split('\n').Length, after = res.NewText.Split('\n').Length;
                    Console.WriteLine("   page ref gone: " + refGone + " | lines " + before + " -> " + after + " (removed " + (before - after) + ")");
                    string? outFile = ArgAfter(args, "--out"); // debug: write the edited text to a SEPARATE file (never the source)
                    if (outFile != null) System.IO.File.WriteAllText(outFile, res.NewText);
                    Console.WriteLine("RESULT: " + (refGone ? "PASS" : "FAIL — dangling page ref"));
                    return refGone ? 0 : 1;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
                    Console.WriteLine(ex.StackTrace);
                    return 1;
                }
            }

            if (Has(args, "--set-image", out string? siFile) && siFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "this";
                string? prop = ArgAfter(args, "--prop");
                string propType = ArgAfter(args, "--propType") ?? "System.Drawing.Image";
                string? imagePath = ArgAfter(args, "--image");
                bool write = Has(args, "--write", out _);
                if (prop == null || imagePath == null)
                {
                    Console.WriteLine("usage: --set-image <designerFile> [--comp <id>] --prop <name> [--propType <type>] --image <imageFile> [--write]");
                    return 2;
                }
                try
                {
                    string resxPath = ResxPathBeside(siFile);
                    string? resxText = File.Exists(resxPath) ? File.ReadAllText(resxPath) : null;
                    byte[] bytes = File.ReadAllBytes(imagePath);
                    var res = DesignerRenderer.ApplyImageResource(siFile, comp, prop, propType, bytes, resxText);
                    Console.WriteLine("== engine set-image (embed into .resx + resources.GetObject assignment)");
                    Console.WriteLine("   target : " + comp + "." + prop + " : " + propType);
                    Console.WriteLine("   image  : " + imagePath + " (" + bytes.Length + " bytes)");
                    Console.WriteLine("   mode   : " + res.Mode + " | key: " + res.ResxKey + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Ok || res.DesignerText == null || res.ResxText == null)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        File.WriteAllText(resxPath, res.ResxText, new System.Text.UTF8Encoding(false));
                        string bak = siFile + ".bak";
                        File.Copy(siFile, bak, overwrite: true);
                        File.WriteAllText(siFile, res.DesignerText, new System.Text.UTF8Encoding(false));
                        Console.WriteLine("   APPLIED: wrote " + siFile + " + " + resxPath + " (backup: " + bak + ")");
                    }
                    else
                    {
                        File.WriteAllText(siFile + ".edited.txt", res.DesignerText, new System.Text.UTF8Encoding(false));
                        File.WriteAllText(resxPath + ".preview.txt", res.ResxText, new System.Text.UTF8Encoding(false));
                        Console.WriteLine("   dry-run: wrote previews " + siFile + ".edited.txt + " + resxPath + ".preview.txt (use --write to apply)");
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

            if (Has(args, "--set-imagelist", out string? ilFile) && ilFile != null)
            {
                string comp = ArgAfter(args, "--comp") ?? "imageList1";
                string? blobFile = ArgAfter(args, "--blob");
                bool write = Has(args, "--write", out _);
                var keys = args.Select((a, i) => (a, i)).Where(x => x.a == "--key").Select(x => args[x.i + 1]).ToArray();
                if (blobFile == null)
                {
                    Console.WriteLine("usage: --set-imagelist <designerFile> [--comp <id>] --blob <base64File> [--key k0]... [--write]");
                    return 2;
                }
                try
                {
                    string resxPath = ResxPathBeside(ilFile);
                    string? resxText = File.Exists(resxPath) ? File.ReadAllText(resxPath) : null;
                    string blob = File.ReadAllText(blobFile).Trim();
                    var res = DesignerRenderer.ApplySetImageList(ilFile, comp, blob, keys, resxText);
                    Console.WriteLine("== engine set-imagelist (ImageStream binary node + SetKeyName, in-code Images.Add removed)");
                    Console.WriteLine("   target : " + comp + " | key: " + res.ResxKey + " | keys: " + string.Join(",", keys) + (res.Reason.Length > 0 ? " | " + res.Reason : ""));
                    if (!res.Ok || res.DesignerText == null || res.ResxText == null)
                    {
                        Console.WriteLine("WARNING: edit rejected — " + (res.Reason.Length > 0 ? res.Reason : "unsafe"));
                        Console.WriteLine("RESULT: FAIL");
                        return 1;
                    }
                    if (write)
                    {
                        File.WriteAllText(resxPath, res.ResxText, new System.Text.UTF8Encoding(false));
                        File.Copy(ilFile, ilFile + ".bak", overwrite: true);
                        File.WriteAllText(ilFile, res.DesignerText, new System.Text.UTF8Encoding(false));
                        Console.WriteLine("   APPLIED: wrote " + ilFile + " + " + resxPath);
                    }
                    else
                    {
                        File.WriteAllText(ilFile + ".edited.txt", res.DesignerText, new System.Text.UTF8Encoding(false));
                        File.WriteAllText(resxPath + ".preview.txt", res.ResxText, new System.Text.UTF8Encoding(false));
                        Console.WriteLine("   dry-run: wrote previews " + ilFile + ".edited.txt + " + resxPath + ".preview.txt");
                    }
                    Console.WriteLine("RESULT: PASS");
                    return 0;
                }
                catch (Exception ex)
                {
                    Console.WriteLine("RESULT: FAIL — " + ex.GetType().Name + ": " + ex.Message);
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
                                          + " depth=" + c.Depth + (c.ParentId != null ? " parent=" + c.ParentId : "")
                                          + (c.IsStripHost ? " [strip-host]" : ""));
                    }
                    if (res.ToolStripItems.Count > 0)
                    {
                        Console.WriteLine("   -- strip items (on-canvas Type Here) --");
                        void PrintTsItem(WinFormsDesigner.Engine.ToolStripItemBounds it, int depth)
                        {
                            Console.WriteLine("   " + new string(' ', depth * 3) + "· " + it.OwnerId + " ▸ " + (it.IsTypeHere ? "[Type Here]" : it.ItemId + " : " + it.ItemType)
                                              + "  @ (" + it.X + "," + it.Y + ") " + it.Width + "x" + it.Height
                                              + (it.Children.Count > 0 ? "  {" + it.Children.Count + " child}" : ""));
                            foreach (var kid in it.Children) PrintTsItem(kid, depth + 1);
                        }
                        foreach (var it in res.ToolStripItems) PrintTsItem(it, 0);
                    }
                    if (res.Tray.Count > 0)
                    {
                        Console.WriteLine("   -- tray (non-visual + off-tree components) --");
                        void PrintTrayItem(WinFormsDesigner.Engine.ToolStripItemBounds it, int depth)
                        {
                            Console.WriteLine("   " + new string(' ', depth * 3) + "     ▸ " + it.ItemId + " : " + it.ItemType + " text=\"" + it.Text + "\""
                                              + (it.Children.Count > 0 ? "  {" + it.Children.Count + " child}" : ""));
                            foreach (var kid in it.Children) PrintTrayItem(kid, depth + 1);
                        }
                        foreach (var t in res.Tray)
                        {
                            Console.WriteLine("   [tray] " + t.Name + " [id=" + t.Id + "] : " + t.Type + (t.IsStrip ? " [strip]" : "") + (t.Items.Count > 0 ? "  {" + t.Items.Count + " item}" : ""));
                            foreach (var it in t.Items) PrintTrayItem(it, 0);
                        }
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
                    Console.WriteLine("   inherited: " + res.InheritedBase
                                      + (res.InheritedBase ? "  base=" + res.BaseTypeName : ""));
                    Console.WriteLine("   resx     : " + res.UnrenderableResxCount + " unrenderable");
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
                Console.WriteLine($"== toolbox palette (auto-population): {items.Count} controls");
                foreach (var g in items.GroupBy(i => i.Category).OrderBy(g => g.Key, StringComparer.Ordinal))
                {
                    Console.WriteLine($"-- {g.Key} ({g.Count()})");
                    foreach (var i in g.OrderBy(i => i.Name, StringComparer.Ordinal))
                        Console.WriteLine($"   {i.Name,-22} {(i.IconPng != null ? "[icon]" : "[    ]")} {i.Fqn}");
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

            if (Has(args, "--add", out string? addFile) && addFile != null)
            {
                // Headless self-test for AddControl, incl. the net48 DevExpress path: --proj-fqn supplies the
                // vendor-control FQNs the net48 engine enumerated, so the pure-text splice emits `new <Fqn>()`
                // without a net9 assembly load. e.g. --add F.Designer.cs --parent this --ctl <Fqn> --proj-fqn <Fqn>
                string parent = ArgAfter(args, "--parent") ?? "this";
                string ctl = ArgAfter(args, "--ctl") ?? "Button";
                var fqns = args.Select((a, i) => (a, i)).Where(x => x.a == "--proj-fqn" && x.i + 1 < args.Length).Select(x => args[x.i + 1]).ToList();
                var res = DesignerRenderer.AddControl(addFile, parent, ctl, null, null, null, ArgAfter(args, "--asm"), fqns.Count > 0 ? fqns : null);
                Console.WriteLine($"== add '{ctl}' to '{parent}': safe={res.Safe} name={res.Name}{(res.Reason.Length > 0 ? " reason=" + res.Reason : "")}");
                if (res.Safe && res.NewText != null)
                    foreach (var line in res.NewText.Split('\n').Where(l => res.Name.Length > 0 && l.Contains(res.Name)).Take(10))
                        Console.WriteLine("   " + line.TrimEnd());
                Console.WriteLine(res.Safe ? "RESULT: PASS" : "RESULT: FAIL");
                return res.Safe ? 0 : 1;
            }

            if (Has(args, "--palette", out _))
            {
                var pal = DesignerPalette.Build();
                Console.WriteLine($"== designer palette (color dropdown + font editor)");
                Console.WriteLine($"   web colors    : {pal.WebColors.Count}");
                Console.WriteLine($"   system colors : {pal.SystemColors.Count}");
                Console.WriteLine($"   font families : {pal.FontFamilies.Count}");
                Console.WriteLine($"   font units    : {string.Join(", ", pal.FontUnits.Select(u => u.Name + "=" + u.Suffix))}");
                foreach (var c in pal.WebColors.Take(5)) Console.WriteLine($"   web   {c.Name,-20} #{c.Argb}");
                foreach (var c in pal.SystemColors.Take(5)) Console.WriteLine($"   sys   {c.Name,-20} #{c.Argb}");
                bool ok = pal.WebColors.Count > 0 && pal.FontFamilies.Count > 0 && pal.FontUnits.Count > 0;
                Console.WriteLine(ok ? "RESULT: PASS" : "RESULT: FAIL");
                return ok ? 0 : 1;
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
            Console.WriteLine("       Engine --palette   (color dropdown + font editor palette: known colors, installed fonts, unit suffixes)");
            Console.WriteLine("       Engine --resolve <designerFile>   (print MSBuild-resolved output assembly)");
            Console.WriteLine("       Engine --pipe <name>");
            return 2;
        }

        /// <summary>The sibling .resx path for a designer file (Foo.Designer.cs / Foo.cs → Foo.resx) — mirrors
        /// ResxResolver's derivation, for the --set-image CLI.</summary>
        private static string ResxPathBeside(string designerFilePath)
        {
            string dir = Path.GetDirectoryName(designerFilePath) ?? ".";
            string name = Path.GetFileName(designerFilePath);
            string @base = name.EndsWith(".Designer.cs", StringComparison.OrdinalIgnoreCase)
                ? name.Substring(0, name.Length - ".Designer.cs".Length)
                : name.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)
                    ? name.Substring(0, name.Length - ".cs".Length)
                    : name;
            return Path.Combine(dir, @base + ".resx");
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

    /// <summary>Engine self-description returned by the capability handshake.</summary>
    public sealed class EngineCapabilities
    {
        public string Engine { get; set; } = "";
        public bool Render { get; set; }
        public bool Edit { get; set; }
        public bool LivePreviewUnsavedEdits { get; set; }
        public string Runtime { get; set; } = "";
        public string Notes { get; set; } = "";
    }

    /// <summary>JSON-RPC surface exposed to the VS Code extension.</summary>
    public sealed class EngineApi
    {
        private readonly StaDispatcher _sta;
        public EngineApi(StaDispatcher sta) => _sta = sta;

        public string Ping() => "winforms-engine ok / " + RuntimeInformation.FrameworkDescription;

        public EngineCapabilities GetCapabilities() => new EngineCapabilities
        {
            Engine = "modern-interpreted",
            Render = true,
            Edit = true,
            LivePreviewUnsavedEdits = true,
            Runtime = RuntimeInformation.FrameworkDescription,
            Notes = "Allowlisted source interpretation with immediate unsaved-buffer preview and source-first edits.",
        };

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
        public RenderLayoutResult RenderWithLayout(string designerFilePath, string? controlAssemblyPath = null, string? sourceText = null, int renderScale = 1)
        {
            Prewarm(designerFilePath, controlAssemblyPath);
            return _sta.Invoke(() => DesignerRenderer.RenderWithLayout(designerFilePath, NullIfBlank(controlAssemblyPath), sourceText, renderScale));
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
        /// source) WITHOUT writing — the host applies it as a WorkspaceEdit (the engine
        /// never writes files itself). <see cref="SavePreview.Text"/> is null when the source is not
        /// safe to round-trip (safe-save read-only fallback). controlAssemblyPath optionally overrides
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
                ReasonCategory = SaveSafety.CategoryName(SaveSafety.Classify(r.RoundTrip.Unrepresentable, r.MissingStatements)),
            };
        });
        }

        /// <summary>
        /// Serialize a .Designer.cs back to a normalized InitializeComponent WITHOUT writing —
        /// the round-trip preview (the explicit-asm-aware RPC complement to the CLI --roundtrip).
        /// <see cref="SerializePreview.Code"/> is null when the source doesn't fully round-trip.
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

        /// <summary>
        /// Edit the design-time "Modifiers" pseudo-property WITHOUT writing (host applies as WorkspaceEdit). Byte-local:
        /// only the target component's field-declaration access keyword changes, so it is safe on EVERY form (it never
        /// touches InitializeComponent / the whole-file serializer). A pure Roslyn text edit — no graph load / STA.
        /// </summary>
        public EditPreview SetModifier(string designerFilePath, string componentName, string newModifier, string? sourceText = null)
        {
            string source = sourceText ?? System.IO.File.ReadAllText(designerFilePath);
            var r = DesignerModifiers.SetModifier(source, componentName, newModifier);
            return new EditPreview { Safe = r.Safe, Mode = r.Safe ? "Modifier" : "Failed", Text = r.Text, Reason = r.Reason };
        }

        /// <summary>safe-save-gated grid-cell edit: move a TableLayoutPanel child to column/row by swapping the cell args of
        /// its 3-arg Controls.Add. Either column or row may be null to leave that coordinate unchanged.</summary>
        public EditPreview SetTableCell(string designerFilePath, string childId, int? column, int? row, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyTableCellEdit(designerFilePath, childId, column, row, sourceText);
            return new EditPreview { Safe = r.Safe, Mode = r.Mode.ToString(), Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Reset a property to its default by deleting its assignment(s) (VS "Reset"; the engine side of
        /// Dock↔Anchor mutual exclusivity). Nothing is interpolated. Host applies <see cref="EditPreview.Text"/> as
        /// a WorkspaceEdit. Mode: "Remove" (removed), "Noop" (already default → Text null), "Failed" (rejected).</summary>
        public EditPreview ResetProperty(string designerFilePath, string componentName, string propertyName, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyPropertyReset(designerFilePath, componentName, propertyName, sourceText);
            return new EditPreview { Safe = r.Ok, Mode = r.Ok ? (r.Changed ? "Remove" : "Noop") : "Failed", Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Import an image into a resx-backed image/icon property: embed the (base64) bytes into the form's
        /// sibling .resx and write the <c>resources.GetObject</c> assignment into InitializeComponent. Returns BOTH
        /// new texts — the host writes <see cref="ImageEditPreview.ResxText"/> to the .resx and applies
        /// <see cref="ImageEditPreview.DesignerText"/> as an undoable edit. resxText is the current .resx content
        /// (null/blank ⇒ create it). Pure text + GDI+ decode-validation — no STA. See <see cref="DesignerImageEditor"/>.</summary>
        public ImageEditPreview SetImageResource(string designerFilePath, string componentName, string propertyName,
            string propertyTypeName, string imageBase64, string? resxText = null, string? sourceText = null)
        {
            byte[] bytes;
            try { bytes = Convert.FromBase64String(imageBase64 ?? ""); }
            catch { return new ImageEditPreview { Safe = false, Mode = "Failed", Reason = "image data is not valid base64" }; }
            var r = DesignerRenderer.ApplyImageResource(designerFilePath, componentName, propertyName, propertyTypeName, bytes, resxText, NullIfBlank(sourceText));
            return new ImageEditPreview
            {
                Safe = r.Ok,
                Mode = r.Mode.ToString(),
                DesignerText = r.DesignerText,
                ResxText = r.ResxText,
                ResxKey = r.ResxKey,
                Reason = r.Reason,
            };
        }

        /// <summary>0.11.0 ImageList editor — embed a serialized ImageStream blob (produced by the net48 serializer)
        /// into the sibling .resx and rewrite the ImageList's init (ImageStream assignment + SetKeyName, removing any
        /// in-code Images.Add). Returns both new texts; the host persists them atomically + undoably.</summary>
        public ImageEditPreview SetImageList(string designerFilePath, string componentId, string imageStreamBase64,
            string[] keys, string? resxText = null, string? sourceText = null,
            string[]? oldKeys = null, int[]? oldIndexForNew = null)
        {
            var r = DesignerRenderer.ApplySetImageList(designerFilePath, componentId, imageStreamBase64 ?? "",
                keys ?? Array.Empty<string>(), resxText, NullIfBlank(sourceText), oldKeys, oldIndexForNew);
            return new ImageEditPreview
            {
                Safe = r.Ok,
                Mode = r.Ok ? "ImageList" : "Failed",
                DesignerText = r.DesignerText,
                ResxText = r.ResxText,
                ResxKey = r.ResxKey,
                Reason = r.Reason,
            };
        }

        /// <summary>Read a TableLayoutPanel's ordered column + row sizing styles (read side for the style editor).</summary>
        public TableStylesResult ReadTableStyles(string designerFilePath, string panelId, string? sourceText = null)
            => DesignerRenderer.ReadTableStyles(designerFilePath, panelId, sourceText);

        /// <summary>safe-save-gated TableLayoutPanel size-style edit: set the Nth Column/Row style's SizeType and/or value.
        /// SizeType is a validated enum member (Absolute/Percent/AutoSize) and value a plain number — nothing is
        /// interpolated. Either may be null to keep the existing one. Host applies Text as a WorkspaceEdit.</summary>
        public EditPreview SetTableStyle(string designerFilePath, string panelId, string axis, int index, string? sizeType, double? value, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyTableStyleEdit(designerFilePath, panelId, axis, index, sizeType, value, sourceText);
            return new EditPreview { Safe = r.Safe, Mode = r.Mode.ToString(), Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Read a string-item collection's current items (ComboBox/ListBox/CheckedListBox.Items) for the
        /// VS-style collection editor. <see cref="CollectionItemsResult.Ok"/> is false for a non-literal
        /// (bound/complex) collection so the webview keeps it read-only.</summary>
        public CollectionItemsResult ListCollectionItems(string designerFilePath, string ownerId, string propertyName, string? sourceText = null)
            => DesignerRenderer.ListCollectionItems(designerFilePath, ownerId, propertyName, NullIfBlank(sourceText));

        /// <summary>Set a string-item collection's items (VS "String Collection Editor"): rewrite the owner's
        /// Add/AddRange calls to exactly <paramref name="items"/>. Items are emitted as escaped string literals —
        /// nothing is interpolated. Host applies <see cref="EditPreview.Text"/> as a WorkspaceEdit.</summary>
        public EditPreview SetCollectionItems(string designerFilePath, string ownerId, string propertyName, string[] items, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyCollectionEdit(designerFilePath, ownerId, propertyName, items ?? Array.Empty<string>(), NullIfBlank(sourceText));
            return new EditPreview { Safe = r.Safe, Mode = r.Mode.ToString(), Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Read a generic <c>string[]</c> property's current items (TextBox/RichTextBox.Lines) for the
        /// string-array editor. <see cref="CollectionItemsResult.Ok"/> is false for a non-literal (bound/computed)
        /// value so the webview keeps it read-only.</summary>
        public CollectionItemsResult ListStringArray(string designerFilePath, string ownerId, string propertyName, string? sourceText = null)
            => DesignerRenderer.ListStringArray(designerFilePath, ownerId, propertyName, NullIfBlank(sourceText));

        /// <summary>Set a generic <c>string[]</c> property (TextBox/RichTextBox.Lines): rewrite it to the single
        /// canonical assignment <c>owner.prop = new string[] { … }</c>. Items are emitted as escaped string literals —
        /// nothing is interpolated. Host applies <see cref="EditPreview.Text"/> as a WorkspaceEdit.</summary>
        public EditPreview SetStringArray(string designerFilePath, string ownerId, string propertyName, string[] items, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyStringArrayEdit(designerFilePath, ownerId, propertyName, items ?? Array.Empty<string>(), NullIfBlank(sourceText));
            return new EditPreview { Safe = r.Safe, Mode = r.Mode.ToString(), Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Read a ListView's columns (typed collection editor) — ColumnHeader field id + Text/Width/TextAlign.
        /// <see cref="ColumnItemsResult.Ok"/> is false for a column that isn't a plain named field with only those
        /// three properties (inline/cast/unmanaged property), so the webview keeps the collection read-only.</summary>
        public ColumnItemsResult ListColumns(string designerFilePath, string ownerId, string? sourceText = null)
            => DesignerRenderer.ListColumnItems(designerFilePath, ownerId, NullIfBlank(sourceText));

        /// <summary>Set a ListView's columns (VS "Collection Editor"): reconcile field declarations, per-column
        /// construction/property statements and Columns.AddRange to exactly <paramref name="columns"/>. Values are
        /// emitted as literals/enum members — nothing is interpolated. Host applies <see cref="EditPreview.Text"/>.</summary>
        public EditPreview SetColumns(string designerFilePath, string ownerId, ColumnItem[] columns, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyColumnsEdit(designerFilePath, ownerId, columns ?? Array.Empty<ColumnItem>(), NullIfBlank(sourceText));
            return new EditPreview { Safe = r.Safe, Mode = r.Mode.ToString(), Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Read a DataGridView's columns (typed grid-column editor) — field id + HeaderText/Width/ReadOnly/Visible.
        /// <see cref="GridColumnItemsResult.Ok"/> is false for a bound/cast/initializer/unmanaged column, so the webview
        /// keeps the collection read-only.</summary>
        public GridColumnItemsResult ListGridColumns(string designerFilePath, string ownerId, string? sourceText = null)
            => DesignerRenderer.ListGridColumnItems(designerFilePath, ownerId, NullIfBlank(sourceText));

        /// <summary>Set a DataGridView's columns (VS "Collection Editor"): reconcile field declarations, per-column
        /// construction/property statements and Columns.AddRange to exactly <paramref name="columns"/>. Values are
        /// emitted as literals/keywords — nothing is interpolated. Host applies <see cref="EditPreview.Text"/>.</summary>
        public EditPreview SetGridColumns(string designerFilePath, string ownerId, GridColumnItem[] columns, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyGridColumnsEdit(designerFilePath, ownerId, columns ?? Array.Empty<GridColumnItem>(), NullIfBlank(sourceText));
            return new EditPreview { Safe = r.Safe, Mode = r.Mode.ToString(), Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Read a TreeView's node forest (hierarchical collection editor) — recursive local id + Text/Name +
        /// children. <see cref="TreeNodeItemsResult.Ok"/> is false for an unmanaged property, an unsupported ctor
        /// overload, a non-local child/root reference or a shared/unattached node, so the webview keeps it read-only.</summary>
        public TreeNodeItemsResult ListNodes(string designerFilePath, string ownerId, string? sourceText = null)
            => DesignerRenderer.ListNodeItems(designerFilePath, ownerId, NullIfBlank(sourceText));

        /// <summary>Set a TreeView's nodes (VS "TreeNode Editor"): drop and regenerate the TreeNode local declarations
        /// + Nodes.AddRange in post-order to exactly <paramref name="nodes"/>. Text/Name are emitted as literals —
        /// nothing is interpolated. Host applies <see cref="EditPreview.Text"/>.</summary>
        public EditPreview SetNodes(string designerFilePath, string ownerId, TreeNodeItem[] nodes, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyNodesEdit(designerFilePath, ownerId, nodes ?? Array.Empty<TreeNodeItem>(), NullIfBlank(sourceText));
            return new EditPreview { Safe = r.Safe, Mode = r.Mode.ToString(), Text = r.NewText, Reason = r.Reason };
        }

        /// <summary>Read a ToolStrip/MenuStrip item tree (VS "…" collection editor) — recursive item field id + Text/
        /// Name/type + nested DropDownItems. <see cref="ToolStripItemsResult.Ok"/> is false for an inline/shared item,
        /// an unexpected collection shape, or a non-field element, so the webview keeps it read-only.</summary>
        public ToolStripItemsResult ListToolStripItems(string designerFilePath, string ownerId, string? sourceText = null)
            => DesignerRenderer.ListToolStripItems(designerFilePath, ownerId, NullIfBlank(sourceText));

        /// <summary>Reorder a ToolStrip/MenuStrip item tree: rewrite each Items/DropDownItems AddRange to the
        /// given order (same items, no add/remove/rename), leaving every other statement byte-identical. Host applies
        /// <see cref="EditPreview.Text"/>.</summary>
        public EditPreview SetToolStripItems(string designerFilePath, string ownerId, ToolStripItemModel[] items, string? sourceText = null)
        {
            var r = DesignerRenderer.ApplyToolStripItemsEdit(designerFilePath, ownerId, items ?? Array.Empty<ToolStripItemModel>(), NullIfBlank(sourceText));
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
        public ControlAddResult AddControl(string designerFilePath, string parentId, string controlTypeKey, string? sourceText = null, int? locX = null, int? locY = null, string? controlAssemblyPath = null, List<string>? projectControlFqns = null)
        {
            // A net9 project-control key needs the resolved assembly enumerated; the net48 (DevExpress/
            // net4x) path instead supplies projectControlFqns (net9 can't load that assembly) → no prewarm needed.
            if (projectControlFqns == null) Prewarm(designerFilePath, controlAssemblyPath);
            return DesignerRenderer.AddControl(designerFilePath, parentId, controlTypeKey, sourceText, locX, locY, NullIfBlank(controlAssemblyPath), projectControlFqns);
        }

        /// <summary>Add a new empty tab page to a tab host (pure text edit; pageTypeFqn is the page type). The host
        /// applies the returned text as an unsaved edit, then the net48 engine live-adds the page to the picture.</summary>
        public ControlAddResult AddTabPage(string designerFilePath, string hostId, string pageTypeFqn, string? sourceText = null)
            => DesignerRenderer.AddTabPage(designerFilePath, hostId, pageTypeFqn, sourceText);

        /// <summary>Add a non-visual component (Timer/ToolTip/dialog…) — the tray counterpart of AddControl. No
        /// parent/location; the component is created and appears in the component tray.</summary>
        public ControlAddResult AddComponent(string designerFilePath, string componentTypeKey, string? sourceText = null)
        {
            return DesignerRenderer.AddComponent(designerFilePath, componentTypeKey, sourceText);
        }

        /// <summary>The toolbox's available control type keys (e.g. "Button", "Label", …).</summary>
        public List<string> ListControlTypes() => DesignerRenderer.ControlTypes().ToList();

        /// <summary>The auto-populated toolbox palette: framework controls always, plus the resolved
        /// project assembly's own controls ("Project Controls") when a designer file is given.
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
        public ToolboxScanResult ScanToolboxAssembly(string assemblyPath, string[]? probeDirectories = null) =>
            DesignerRenderer.ScanAssemblyCandidates(assemblyPath, false, probeDirectories);

        /// <summary>Remove a leaf control (field decl + its InitializeComponent statements) as a text edit.
        /// PURE TEXT — no graph load/STA. Refuses a container with children / externally-referenced control.</summary>
        public ControlRemoveResult RemoveControl(string designerFilePath, string controlId, string? sourceText = null) =>
            DesignerRenderer.RemoveControl(designerFilePath, controlId, sourceText);

        /// <summary>Remove a whole tab page (page + its entire subtree) from a tab host as a text edit; detaches the
        /// page from the host's tab collection (whole Controls.Add/TabPages.Add, or a trimmed TabPages.AddRange
        /// element). PURE TEXT — no graph load/STA. The host applies the returned text, then the net48 engine
        /// live-removes the page from the picture.</summary>
        public ControlRemoveResult RemoveTabPage(string designerFilePath, string hostId, string pageId, string? sourceText = null) =>
            DesignerRenderer.RemoveTabPage(designerFilePath, hostId, pageId, sourceText);

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

        /// <summary>reparent: move a leaf control into a different container (or the root form, newParentId
        /// "this"/""). Minimal text edit — rewrites only the child's Controls.Add receiver. See DesignerControlEditor.Reparent.</summary>
        public ControlReorderResult Reparent(string designerFilePath, string childId, string newParentId, string? sourceText = null) =>
            DesignerRenderer.ReparentControl(designerFilePath, childId, newParentId, sourceText);

        /// <summary>
        /// Build a C# initializer expression for a complex framework property value (Point/Size/Color/…)
        /// from its invariant-string form, so the grid can edit types it otherwise shows read-only.
        /// Returns null when the value isn't convertible (caller leaves the property read-only / rejects).
        /// Pure TypeConverter/CodeDom work with no UI-thread affinity, so it runs directly on the RPC
        /// thread (like SetProperty) rather than serializing behind renders on the single STA thread.
        /// </summary>
        public string? ConvertValue(string typeName, string invariantValue) =>
            DesignerValueConverter.ToExpression(typeName, invariantValue);

        /// <summary>Static palette for the property grid's Color dropdown and Font editor: the KnownColor
        /// palette split web/system (theme-accurate ARGB), installed font families, and the authoritative
        /// FontConverter unit suffixes. Pure reflection/GDI — runs on the RPC thread, no STA/Prewarm
        /// (like <see cref="ConvertValue"/>). Independent of any designer file.</summary>
        public DesignerPaletteInfo GetDesignerPalette() => DesignerPalette.Build();
    }

    /// <summary>DTO for the no-write save preview RPC.</summary>
    public sealed class SavePreview
    {
        public bool Safe { get; set; }
        public string? Text { get; set; }
        public string[] Unrepresentable { get; set; } = Array.Empty<string>();
        public string[] MissingStatements { get; set; } = Array.Empty<string>();
        /// <summary>Capability-preflight category explaining WHY the form isn't save-safe (or "safe"): one of
        /// safe / localizable / binaryResx / unresolvedType / lostStatements / unrepresentable.</summary>
        public string ReasonCategory { get; set; } = "safe";
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

    /// <summary>DTO for the image-import RPC (<see cref="EngineApi.SetImageResource"/>): the new .Designer.cs text
    /// AND the new sibling .resx text (both null when rejected). The host writes the .resx and applies the designer
    /// text as an undoable edit.</summary>
    public sealed class ImageEditPreview
    {
        public bool Safe { get; set; }
        public string Mode { get; set; } = "";        // Replace | Insert | Failed
        public string? DesignerText { get; set; }
        public string? ResxText { get; set; }
        public string ResxKey { get; set; } = "";
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
