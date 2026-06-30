using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Xml.Linq;
using Newtonsoft.Json.Linq;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Discovery of a project's built output assembly for a given .Designer.cs (plan §8.6 / §12).
    /// Two strategies, tried in order by <see cref="ResolveOutputAssembly"/>:
    ///   1. MSBuild design-time evaluation — `dotnet msbuild -getProperty:TargetPath`. Correct for
    ///      complex projects (custom OutputPath/BaseOutputPath, multi-target, Configuration). Uses only
    ///      the installed SDK via a subprocess — no hard Microsoft.Build dependency. MSBuild returns the
    ///      *canonical* TargetPath even for an unbuilt project, so we cache the candidate paths (Debug +
    ///      Release for the chosen TFM) and cheaply re-stat them on every lookup: the freshest existing
    ///      one wins (config-agnostic, like the old freshest-bin search), and a project built AFTER it is
    ///      first opened is picked up without re-running MSBuild.
    ///   2. Lightweight freshest bin/ search (<see cref="FindOutputAssemblyFromCsproj"/>) — the
    ///      dependency-free fallback used only when the MSBuild evaluation itself fails (dotnet missing,
    ///      malformed project, or a multi-target project with no host-loadable TFM).
    /// Both feed the same ALC + interpreter gates downstream, so this adds no new code-exec surface
    /// beyond running MSBuild on the project — itself confined to trusted workspaces (extension
    /// package.json capabilities.untrustedWorkspaces.supported=false).
    ///
    /// Resolution is pure (string in → path out, no WinForms/STA affinity); callers pre-warm it OFF the
    /// single STA thread (EngineApi.Prewarm / CLI) so the subprocess never blocks the render surface, and
    /// the STA-side call passes allowEval=false so it can ONLY consume the cache — even if a csproj edit
    /// races the pre-warm, the STA thread degrades to the bin search instead of evaluating. See the
    /// pre-warm calls in Program.cs.
    /// </summary>
    public static class ProjectResolver
    {
        /// <summary>What a single MSBuild evaluation produced for a project, cached per csproj.</summary>
        private sealed class CacheEntry
        {
            public required long CsprojMtimeTicks { get; init; }
            // Candidate output paths (Debug + Release for the chosen TFM). May point at not-yet-built
            // files — we re-stat on each lookup and return the freshest that exists. Null means the
            // MSBuild evaluation itself failed (so the bin-search fallback should run).
            public required IReadOnlyList<string>? Candidates { get; init; }
            public required long EvaluatedAtUtcTicks { get; init; }
        }

        // One entry per csproj full path (overwritten on mtime change), so the cache is bounded to the
        // number of distinct projects seen — not monotonic growth across edits/builds.
        private static readonly ConcurrentDictionary<string, CacheEntry> _cache = new();

        // A failed evaluation (null candidates) is retried after this window, so a transient miss
        // (dotnet briefly unavailable) recovers without re-running a failing eval on every render.
        private static readonly long NegativeTtlTicks = TimeSpan.FromSeconds(10).Ticks;

        // Per-subprocess cap. Runs off the STA thread, so a slow eval delays only its own render's
        // resolution, never the whole engine. Generous for property evaluation (which does not build).
        private const int EvalTimeoutMs = 20_000;

        // This host's runtime major version: a .NET assembly with a higher major (e.g. net10) cannot be
        // loaded here, so such a TFM is excluded when selecting among a multi-target project's frameworks.
        private static readonly int HostMajor = Environment.Version.Major;

        public static string? FindCsproj(string designerFilePath)
        {
            var dir = new DirectoryInfo(Path.GetDirectoryName(Path.GetFullPath(designerFilePath))!);
            for (var d = dir; d != null; d = d.Parent)
            {
                var found = d.GetFiles("*.csproj");
                if (found.Length > 0)
                {
                    return found[0].FullName;
                }
            }
            return null;
        }

        /// <summary>
        /// Best resolution of the built output assembly for the project owning the file: MSBuild
        /// design-time evaluation first, lightweight bin/ search as fallback. Returns null if neither
        /// yields an existing assembly. Pure and safe to call off the STA thread (and to pre-warm).
        ///
        /// <paramref name="allowEval"/> controls whether a cache miss/stale entry may spawn the MSBuild
        /// subprocess. The off-STA pre-warm and the ResolveAssembly RPC pass true; the STA render path
        /// (LoadGraph) passes false so it NEVER blocks the single render thread on MSBuild — on a cache
        /// miss it just falls back to the (cheap) bin search, and the next pre-warm refreshes the cache.
        /// </summary>
        public static string? ResolveOutputAssembly(string designerFilePath, bool allowEval = true)
        {
            string? csproj = FindCsproj(designerFilePath);
            if (csproj == null)
            {
                return null;
            }

            string? viaMsbuild = TryResolveViaMSBuild(csproj, allowEval);
            if (viaMsbuild != null)
            {
                return viaMsbuild;
            }
            return FindOutputAssemblyFromCsproj(csproj);
        }

        // ---- MSBuild design-time evaluation (strategy 1) ----

        private static string? TryResolveViaMSBuild(string csproj, bool allowEval)
        {
            string full;
            long mtime;
            try
            {
                full = Path.GetFullPath(csproj);
                mtime = File.GetLastWriteTimeUtc(full).Ticks;
            }
            catch
            {
                return null;
            }
            long now = DateTime.UtcNow.Ticks;

            if (_cache.TryGetValue(full, out CacheEntry? entry) && entry.CsprojMtimeTicks == mtime)
            {
                if (entry.Candidates != null)
                {
                    // Successful eval: re-stat the known candidates (cheap) so a build that happens
                    // after the first open — and the freshest config — is reflected without re-running MSBuild.
                    return FreshestExisting(entry.Candidates);
                }
                if (now - entry.EvaluatedAtUtcTicks < NegativeTtlTicks)
                {
                    return null; // eval failed recently; don't hammer it
                }
            }

            // A (re)evaluation is needed (cache miss, csproj edited since, or the negative TTL lapsed).
            // The STA render path forbids it (allowEval=false) so the subprocess can't freeze the render
            // thread even when a csproj edit races the pre-warm; it degrades to the bin search below.
            if (!allowEval)
            {
                return null;
            }
            IReadOnlyList<string>? candidates = EvaluateCandidates(full);
            _cache[full] = new CacheEntry { CsprojMtimeTicks = mtime, Candidates = candidates, EvaluatedAtUtcTicks = now };
            return candidates == null ? null : FreshestExisting(candidates);
        }

        private static string? FreshestExisting(IReadOnlyList<string> candidates)
        {
            return candidates
                .Where(File.Exists)
                .Select(p => new FileInfo(p))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Select(f => f.FullName)
                .FirstOrDefault();
        }

        /// <summary>
        /// Evaluate the canonical output paths for Debug and Release (for the chosen TFM). Returns the
        /// candidate paths (which may not exist yet), or null if the evaluation itself failed so the
        /// caller falls back to the bin-search.
        /// </summary>
        private static IReadOnlyList<string>? EvaluateCandidates(string csprojFullPath)
        {
            // Pass 1, default configuration: read TargetFrameworks (and TargetPath for a single-target project).
            var first = RunGetProperty(csprojFullPath, tfm: null, configuration: null);
            if (first == null)
            {
                return null;
            }

            string targetFrameworks = first.GetValueOrDefault("TargetFrameworks", "");
            string? tfm = null;
            if (!string.IsNullOrWhiteSpace(targetFrameworks))
            {
                tfm = ChooseTfm(targetFrameworks);
                if (tfm == null)
                {
                    // Multi-target project with no host-loadable TFM — don't surface an unloadable
                    // assembly; let the bin-search fallback run instead.
                    return null;
                }
            }
            else
            {
                // Single-target: gate the project's own TFM through the same host-loadability check, so a
                // net48 / higher-than-host single-target output isn't surfaced — loading it into the net
                // collectible ALC would throw and abort the render (the bin-search fallback runs instead).
                string single = first.GetValueOrDefault("TargetFramework", "");
                if (!string.IsNullOrWhiteSpace(single) && ScoreLoadable(single) == 0)
                {
                    return null;
                }
            }

            var paths = new List<string>();

            // Default (Debug) candidate. For a single-target project pass 1 already carries TargetPath;
            // for a multi-target one we must re-evaluate with the chosen TFM.
            string? debug = tfm == null
                ? first.GetValueOrDefault("TargetPath", "")
                : RunGetProperty(csprojFullPath, tfm, configuration: null)?.GetValueOrDefault("TargetPath", "");
            AddIfPath(paths, debug);

            // Release candidate, so a workspace iterating in Release is honored (freshest existing wins).
            string? release = RunGetProperty(csprojFullPath, tfm, configuration: "Release")
                ?.GetValueOrDefault("TargetPath", "");
            AddIfPath(paths, release);

            return paths.Count == 0 ? null : paths;
        }

        private static void AddIfPath(List<string> paths, string? p)
        {
            if (!string.IsNullOrWhiteSpace(p))
            {
                string full = Path.GetFullPath(p);
                if (!paths.Contains(full, StringComparer.OrdinalIgnoreCase))
                {
                    paths.Add(full);
                }
            }
        }

        private static Dictionary<string, string>? RunGetProperty(string csprojFullPath, string? tfm, string? configuration)
        {
            try
            {
                var psi = new ProcessStartInfo
                {
                    FileName = DotnetExe(),
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true,
                    WorkingDirectory = Path.GetDirectoryName(csprojFullPath) ?? Environment.CurrentDirectory,
                };
                // Do NOT let MSBuild hand off to a reusable/persistent worker node: such a node inherits
                // our redirected stdout pipe and keeps it open after the main process exits, so the read
                // task below would never see EOF and block forever (the cause of a stuck "Rendering…").
                psi.Environment["MSBUILDNODEREUSE"] = "0";
                psi.Environment["DOTNET_CLI_TELEMETRY_OPTOUT"] = "1";
                psi.ArgumentList.Add("msbuild");
                psi.ArgumentList.Add(csprojFullPath);
                psi.ArgumentList.Add("-nologo");
                psi.ArgumentList.Add("-nodeReuse:false");
                psi.ArgumentList.Add("-getProperty:TargetPath");
                psi.ArgumentList.Add("-getProperty:TargetFramework");
                psi.ArgumentList.Add("-getProperty:TargetFrameworks");
                if (tfm != null)
                {
                    psi.ArgumentList.Add("-p:TargetFramework=" + tfm);
                }
                if (configuration != null)
                {
                    psi.ArgumentList.Add("-p:Configuration=" + configuration);
                }

                using var p = Process.Start(psi);
                if (p == null)
                {
                    return null;
                }
                // Read both streams asynchronously to avoid a pipe-buffer deadlock; bound the wait, then
                // collect the reads once the process has exited (or been killed, which closes the pipes so
                // the reads complete). The synchronous waits are intentional — this utility runs off the
                // STA thread, where blocking on the subprocess is the desired behavior.
                var outTask = p.StandardOutput.ReadToEndAsync();
                var errTask = p.StandardError.ReadToEndAsync();
                bool exited = p.WaitForExit(EvalTimeoutMs);
                if (!exited)
                {
                    try { p.Kill(true); } catch { /* best effort */ }
                }
#pragma warning disable VSTHRD002 // bounded synchronous waits, intentional for this off-STA utility
                // Bound the stream collection. -nodeReuse:false above should ensure no inherited pipe is
                // held open, but if one ever is the read tasks would never complete — abandon them after a
                // short grace rather than block the caller forever.
                bool readsDone = Task.WaitAll(new Task[] { outTask, errTask }, 3000);
                if (!exited || !readsDone)
                {
                    return null;
                }
                // Both tasks are complete here, so .Result does not block.
                string stdout = outTask.Result;
                string stderr = errTask.Result;
#pragma warning restore VSTHRD002
                if (p.ExitCode != 0)
                {
                    string firstLine = stderr.Split('\n').FirstOrDefault(l => l.Trim().Length > 0)?.Trim() ?? "(no stderr)";
                    Console.Error.WriteLine($"[engine] msbuild eval exit {p.ExitCode} for {csprojFullPath}: {firstLine}");
                    return null;
                }
                return ParseProps(stdout);
            }
            catch (Exception ex)
            {
                // dotnet not on PATH, access denied, malformed project — fall back to bin search.
                Console.Error.WriteLine($"[engine] msbuild eval failed for {csprojFullPath}: {ex.GetType().Name}: {ex.Message}");
                return null;
            }
        }

        /// <summary>Multiple `-getProperty` flags make MSBuild emit a JSON object: {"Properties":{...}}.</summary>
        private static Dictionary<string, string>? ParseProps(string stdout)
        {
            // -getProperty emits a single JSON document; parse it directly. Only if that fails do we
            // fall back to locating the first '{' (defensive against any stray leading output).
            JObject? jo = TryParse(stdout.Trim()) ?? TryParseFromFirstBrace(stdout);
            if (jo?["Properties"] is not JObject props)
            {
                return null;
            }
            var dict = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var kv in props)
            {
                dict[kv.Key] = kv.Value?.ToString() ?? "";
            }
            return dict;
        }

        private static JObject? TryParse(string s)
        {
            try { return JObject.Parse(s); } catch { return null; }
        }

        private static JObject? TryParseFromFirstBrace(string s)
        {
            int brace = s.IndexOf('{');
            return brace < 0 ? null : TryParse(s.Substring(brace));
        }

        // Modern .NET TFM: net<major>.<minor> with an optional OS suffix. The OS part is the platform
        // name (letters) optionally followed by a platform version (e.g. net9.0-windows10.0.19041.0,
        // net8.0-windows7.0) — common for WinForms projects pinning a Windows SDK. Group 3 captures only
        // the platform name (so the windows bonus still fires); the trailing version is matched but
        // discarded. Legacy net48 / netstandard2.0 / netcoreapp3.1 still fall through (no '.' major.minor).
        private static readonly Regex NetCoreTfm =
            new(@"^net(\d+)\.(\d+)(?:-([a-z]+)[\d.]*)?$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        /// <summary>
        /// Pick the best TFM from a multi-target project's TargetFrameworks: among the HOST-LOADABLE
        /// modern .NET TFMs (clean net&lt;major&gt;.&lt;minor&gt; with major ≤ host), prefer the Windows
        /// variant (WinForms requires it) then the highest version. Returns null when none is loadable
        /// (all-legacy net4x / netstandard / higher-than-host), so the caller skips MSBuild and lets the
        /// bin-search fallback run rather than returning an assembly this runtime cannot load.
        /// </summary>
        private static string? ChooseTfm(string targetFrameworks)
        {
            return targetFrameworks
                .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(t => (tfm: t, score: ScoreLoadable(t)))
                .Where(x => x.score > 0)
                .OrderByDescending(x => x.score)
                .Select(x => x.tfm)
                .FirstOrDefault();
        }

        /// <summary>Score a host-loadable modern TFM (windows preferred, then version); 0 if not loadable.</summary>
        private static long ScoreLoadable(string tfm)
        {
            var m = NetCoreTfm.Match(tfm);
            if (!m.Success)
            {
                return 0; // net48 / netstandard2.0 / netcoreapp3.1 — not a clean modern net TFM
            }
            int major = int.Parse(m.Groups[1].Value);
            int minor = int.Parse(m.Groups[2].Value);
            if (major > HostMajor)
            {
                return 0; // a higher-major assembly cannot load on this runtime
            }
            bool windows = m.Groups[3].Value.Equals("windows", StringComparison.OrdinalIgnoreCase);
            return (windows ? 1_000_000L : 0L) + major * 1_000L + minor * 10L + 1; // +1 so a loadable net0.0 still beats 0
        }

        private static string DotnetExe()
        {
            // Locate the dotnet host. DOTNET_HOST_PATH is set when the engine is started via the native
            // apphost .exe, but NOT when started as `dotnet Engine.dll` (the muxer-DLL launch the
            // extension uses), so in practice the PATH-resolved name is the normal path. Try, in order:
            // DOTNET_HOST_PATH, DOTNET_ROOT/dotnet[.exe], then the PATH name.
            string? hostPath = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH");
            if (!string.IsNullOrEmpty(hostPath) && File.Exists(hostPath))
            {
                return hostPath;
            }
            string? root = Environment.GetEnvironmentVariable("DOTNET_ROOT");
            if (!string.IsNullOrEmpty(root))
            {
                string exe = Path.Combine(root, OperatingSystem.IsWindows() ? "dotnet.exe" : "dotnet");
                if (File.Exists(exe))
                {
                    return exe;
                }
            }
            return "dotnet";
        }

        // ---- lightweight bin/ search (strategy 2, fallback) ----

        private static string? FindOutputAssemblyFromCsproj(string csproj)
        {
            string asmName = ReadAssemblyName(csproj) ?? Path.GetFileNameWithoutExtension(csproj);
            string projDir = Path.GetDirectoryName(csproj)!;
            string bin = Path.Combine(projDir, "bin");
            if (!Directory.Exists(bin))
            {
                return null;
            }
            // freshest bin/**/<asmName>.dll
            return Directory.EnumerateFiles(bin, asmName + ".dll", SearchOption.AllDirectories)
                .Select(p => new FileInfo(p))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Select(f => f.FullName)
                .FirstOrDefault();
        }

        private static string? ReadAssemblyName(string csproj)
        {
            try
            {
                var doc = XDocument.Load(csproj);
                string? an = doc.Descendants()
                    .FirstOrDefault(e => e.Name.LocalName == "AssemblyName")?.Value;
                return string.IsNullOrWhiteSpace(an) ? null : an.Trim();
            }
            catch
            {
                return null;
            }
        }
    }
}
