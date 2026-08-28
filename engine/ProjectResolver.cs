using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection.PortableExecutable;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Newtonsoft.Json.Linq;

namespace WinFormsDesigner.Engine
{
    public enum DesignerDocumentOwnerStatus
    {
        Resolved,
        AmbiguousOwner,
        MissingInitializeComponent,
        UnsupportedNestedDesigner,
        NoProject
    }

    public sealed class DesignerDocumentOwnerResolution
    {
        public DesignerDocumentOwnerStatus Status { get; set; }
        public string DiagnosticCode { get; set; } = "";
        public string TypeName { get; set; } = "";
        public string ProjectPath { get; set; } = "";
        public string[] Owners { get; set; } = Array.Empty<string>();
        public bool EmptyInitializeComponentSurface { get; set; }
        /// <summary>True when more than one project compiles this file and none of them can influence the render, so
        /// <see cref="ProjectPath"/> is a deterministic pick among <see cref="Owners"/> rather than the sole owner.
        /// See the modern-inert rule in <c>ResolveDesignerDocumentOwner</c>.</summary>
        public bool SelectedAmongEquivalentOwners { get; set; }

        public static DesignerDocumentOwnerResolution MissingInitializeComponent() => new()
        {
            Status = DesignerDocumentOwnerStatus.MissingInitializeComponent,
            DiagnosticCode = "MISSING_INITIALIZE_COMPONENT"
        };

        public static DesignerDocumentOwnerResolution NoProject() => new()
        {
            Status = DesignerDocumentOwnerStatus.NoProject,
            DiagnosticCode = "NO_PROJECT"
        };

        public static DesignerDocumentOwnerResolution UnsupportedNested(string typeName) => new()
        {
            Status = DesignerDocumentOwnerStatus.UnsupportedNestedDesigner,
            DiagnosticCode = "NESTED_DESIGNER_UNSUPPORTED",
            TypeName = typeName
        };

        public static DesignerDocumentOwnerResolution Ambiguous(IEnumerable<string> owners, string typeName) => new()
        {
            Status = DesignerDocumentOwnerStatus.AmbiguousOwner,
            DiagnosticCode = "AMBIGUOUS_OWNER",
            TypeName = typeName,
            Owners = owners.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToArray()
        };

        public static DesignerDocumentOwnerResolution Resolved(string owner, string typeName,
            bool emptyInitializeComponentSurface = false, string[]? equivalentOwners = null) => new()
        {
            Status = DesignerDocumentOwnerStatus.Resolved,
            DiagnosticCode = "NONE",
            ProjectPath = owner,
            TypeName = typeName,
            Owners = equivalentOwners ?? new[] { owner },
            EmptyInitializeComponentSurface = emptyInitializeComponentSurface,
            SelectedAmongEquivalentOwners = equivalentOwners is { Length: > 1 }
        };
    }

    /// <summary>
    /// Discovery of a project's built output assembly for a given .Designer.cs.
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

        public static DesignerDocumentOwnerResolution ResolveDesignerDocumentOwner(
            string designerFilePath,
            IEnumerable<string> projectPaths,
            string? designerSourceText = null,
            string? codeBehindSourceText = null)
        {
            string source;
            try { source = designerSourceText ?? File.ReadAllText(designerFilePath); }
            catch { return DesignerDocumentOwnerResolution.MissingInitializeComponent(); }

            var root = CSharpSyntaxTree.ParseText(source, path: designerFilePath).GetRoot();
            var form = FormClassResolver.FormClass(root);
            var init = FormClassResolver.InitMethodOf(form);
            bool emptyInitializeComponentSurface = false;
            if (form == null || init?.Body == null)
            {
                form = EmptySurfaceFormClass(root, codeBehindSourceText);
                if (form == null) return DesignerDocumentOwnerResolution.MissingInitializeComponent();
                emptyInitializeComponentSurface = true;
            }

            string typeName = FormClassResolver.QualifiedName(form);
            // Actual Visual Studio Enterprise 2026 18.7 refuses a Form nested inside another type with its
            // fail-closed "none of the classes within it can be designed" page. Do this in the product's mandatory
            // pre-render owner gate: allowing the syntax-only engine to draw a plausible canvas would be a silent
            // compatibility fork, and would expose edits for a document Visual Studio itself cannot design.
            if (form.Ancestors().OfType<TypeDeclarationSyntax>().Any())
                return DesignerDocumentOwnerResolution.UnsupportedNested(typeName);

            string fullDesignerPath;
            try { fullDesignerPath = Path.GetFullPath(designerFilePath); }
            catch { return DesignerDocumentOwnerResolution.NoProject(); }

            var normalizedProjects = projectPaths
                .Select(TryFullPath)
                .Where(projectPath => projectPath != null)
                .Cast<string>()
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
            var owners = normalizedProjects
                .Where(projectPath => ProjectContainsCompileFile(projectPath, fullDesignerPath, normalizedProjects))
                .ToArray();

            if (owners.Length == 0) return DesignerDocumentOwnerResolution.NoProject();
            if (owners.Length > 1)
            {
                // A shared project (.projitems imported by several .csproj) and a file linked into two projects are
                // ordinary Visual Studio layouts, and VS offers a project context for them instead of declaring the
                // document undesignable. Refusing on candidate COUNT alone made every such workspace unrenderable —
                // strictly worse than the previous release, which rendered them.
                //
                // The pick is only safe where the owner cannot influence the render at all. That is exactly the
                // modern route: the host resolves it to { kind: 'modern', asm: undefined } and the engine then finds
                // its own project by walking UP from the designer file (see FindCsproj), so which contender we name
                // never reaches the renderer. On the .NET Framework route the host instead calls
                // resolveFrameworkOutput(owner) and instantiates the form from THAT project's compiled binary, so an
                // arbitrary pick there could render the wrong build (per-project DefineConstants and differing vendor
                // reference versions are the whole reason shared projects exist). Multi-target and unreadable/
                // undeclared TFMs stay ambiguous too — "unknown" must never compare equal to "unknown".
                var ordered = owners.OrderBy(projectPath => projectPath, StringComparer.OrdinalIgnoreCase).ToArray();
                if (ordered.All(IsModernInertOwner))
                    return DesignerDocumentOwnerResolution.Resolved(
                        ordered[0], typeName, emptyInitializeComponentSurface, ordered);
                return DesignerDocumentOwnerResolution.Ambiguous(owners, typeName);
            }
            return DesignerDocumentOwnerResolution.Resolved(owners[0], typeName, emptyInitializeComponentSurface);
        }

        private static ClassDeclarationSyntax? EmptySurfaceFormClass(
            Microsoft.CodeAnalysis.SyntaxNode designerRoot,
            string? codeBehindSourceText)
        {
            if (string.IsNullOrWhiteSpace(codeBehindSourceText)) return null;
            var topLevelTypes = designerRoot.DescendantNodes().OfType<TypeDeclarationSyntax>()
                .Where(candidate => !candidate.Ancestors().OfType<TypeDeclarationSyntax>().Any())
                .ToArray();
            if (topLevelTypes.Length != 1 || topLevelTypes[0] is not ClassDeclarationSyntax designerClass)
                return null;
            if (!designerClass.Modifiers.Any(modifier =>
                    modifier.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PartialKeyword))
                || designerClass.Members.Count != 0
                || designerClass.AttributeLists.Count != 0
                || designerClass.BaseList != null
                || designerClass.TypeParameterList != null
                || designerClass.ConstraintClauses.Count != 0)
                return null;

            var codeRoot = CSharpSyntaxTree.ParseText(codeBehindSourceText).GetRoot();
            string identity = FormClassResolver.QualifiedName(designerClass);
            var matching = codeRoot.DescendantNodes().OfType<ClassDeclarationSyntax>()
                .Where(candidate => FormClassResolver.QualifiedName(candidate) == identity)
                .ToArray();
            if (matching.Length != 1 || !matching[0].Modifiers.Any(modifier =>
                    modifier.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PartialKeyword))) return null;
            TypeSyntax? baseType = matching[0].BaseList?.Types.FirstOrDefault()?.Type;
            return baseType != null && IsFrameworkSurfaceBase(baseType, codeRoot) ? designerClass : null;
        }

        private static bool IsFrameworkSurfaceBase(TypeSyntax baseType, Microsoft.CodeAnalysis.SyntaxNode codeRoot)
        {
            string name = string.Concat(baseType.DescendantTokens(descendIntoTrivia: false).Select(token => token.Text));
            if (name.StartsWith("global::", StringComparison.Ordinal)) name = name.Substring("global::".Length);
            if (name == "System.Windows.Forms.Form" || name == "System.Windows.Forms.UserControl") return true;

            foreach (UsingDirectiveSyntax usingDirective in codeRoot.DescendantNodes().OfType<UsingDirectiveSyntax>())
            {
                string imported = usingDirective.Name?.ToString() ?? "";
                if (usingDirective.Alias != null
                    && usingDirective.Alias.Name.Identifier.Text == name
                    && (imported == "System.Windows.Forms.Form" || imported == "System.Windows.Forms.UserControl"))
                    return true;
                if (usingDirective.Alias == null && imported == "System.Windows.Forms"
                    && (name == "Form" || name == "UserControl")) return true;
            }
            return false;
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

        private sealed class ProjectDocument
        {
            public required string FilePath { get; init; }
            public required XDocument Document { get; init; }
        }

        private static string? TryFullPath(string value)
        {
            try { return Path.GetFullPath(value); }
            catch { return null; }
        }

        private static readonly Regex XmlCommentSpan = new(@"<!--.*?-->", RegexOptions.Compiled | RegexOptions.Singleline);
        private static readonly Regex SingleTargetFramework =
            new(@"<TargetFramework(?:\s[^>]*)?>\s*([^<]+?)\s*</TargetFramework>", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex MultiTargetFrameworks =
            new(@"<TargetFrameworks(?:\s[^>]*)?>", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex ClassicTargetFrameworkVersion =
            new(@"<TargetFrameworkVersion(?:\s[^>]*)?>", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex FrameworkTfm =
            new(@"^net(2|3|4)\d?\d?$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        /// <summary>
        /// True only when this project provably routes to the MODERN engine, where the owner project never reaches
        /// the renderer (the host passes no assembly and the engine finds its own project by walking up from the
        /// designer file). Used to decide whether naming one contender among several co-owners is inert.
        /// <para/>
        /// Deliberately fail-closed and deliberately textual, mirroring the host's own reader
        /// (extension/src/csprojRef.ts <c>projectTargetFramework</c> / <c>isFrameworkTfm</c>) so engine and host cannot
        /// disagree about the route: an unreadable project, one that declares no TFM in its own file (a
        /// Directory.Build.props-driven project), one that multi-targets, and any classic
        /// <c>&lt;TargetFrameworkVersion&gt;</c> or net2x/net3x/net4x project all return false.
        /// </summary>
        private static bool IsModernInertOwner(string projectPath)
        {
            string text;
            try { text = File.ReadAllText(projectPath); }
            catch { return false; }

            string live = XmlCommentSpan.Replace(text, "");
            // Multi-target and classic projects reach the net48 route, where the owner selects the compiled binary.
            if (MultiTargetFrameworks.IsMatch(live) || ClassicTargetFrameworkVersion.IsMatch(live)) return false;

            var single = SingleTargetFramework.Match(live);
            if (!single.Success) return false;
            return !FrameworkTfm.IsMatch(single.Groups[1].Value.Trim());
        }

        private static bool ProjectContainsCompileFile(
            string projectPath,
            string filePath,
            IReadOnlyList<string> workspaceProjects)
        {
            try
            {
                string fullProjectPath = Path.GetFullPath(projectPath);
                string projectDir = Path.GetDirectoryName(fullProjectPath)!;
                string fullFilePath = Path.GetFullPath(filePath);
                var documents = LoadProjectDocuments(fullProjectPath);
                var root = documents[0].Document;
                bool sdkStyle = root.Root?.Attribute("Sdk") != null
                    || root.Root?.Elements().Any(e => e.Name.LocalName == "Sdk") == true;

                foreach (var projectDocument in documents)
                {
                    string itemDir = Path.GetDirectoryName(projectDocument.FilePath)!;
                    foreach (var compile in projectDocument.Document.Descendants().Where(e => e.Name.LocalName == "Compile"))
                    {
                        string? remove = compile.Attribute("Remove")?.Value;
                        if (remove != null && ProjectItemMatches(itemDir, remove, fullFilePath)) return false;
                    }
                }

                foreach (var projectDocument in documents)
                {
                    string itemDir = Path.GetDirectoryName(projectDocument.FilePath)!;
                    foreach (var compile in projectDocument.Document.Descendants().Where(e => e.Name.LocalName == "Compile"))
                    {
                        string? include = compile.Attribute("Include")?.Value;
                        if (include != null && ProjectItemMatches(itemDir, include, fullFilePath)) return true;
                    }
                }

                return sdkStyle
                    && IsInsideProjectDir(projectDir, fullFilePath)
                    && !IsInBuildOutput(projectDir, fullFilePath)
                    // SDK default Compile globs stop at a nested project boundary. Treating both the outer and inner
                    // project as owners made an ordinary nested WinForms project fail as AMBIGUOUS_OWNER.
                    && !IsInsideNestedProject(projectDir, fullProjectPath, fullFilePath, workspaceProjects);
            }
            catch
            {
                return false;
            }
        }

        private static IReadOnlyList<ProjectDocument> LoadProjectDocuments(string rootProjectPath)
        {
            const int MaxImportedDocuments = 128;
            var result = new List<ProjectDocument>();
            var visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var pending = new Queue<string>();
            pending.Enqueue(Path.GetFullPath(rootProjectPath));
            while (pending.Count > 0)
            {
                string current = pending.Dequeue();
                if (!visited.Add(current)) continue;
                if (result.Count >= MaxImportedDocuments) throw new InvalidDataException("project import graph is too large");
                var document = XDocument.Load(current);
                result.Add(new ProjectDocument { FilePath = current, Document = document });
                string currentDir = Path.GetDirectoryName(current)!;
                foreach (var import in document.Descendants().Where(e => e.Name.LocalName == "Import"))
                {
                    string? importValue = import.Attribute("Project")?.Value;
                    if (string.IsNullOrWhiteSpace(importValue)) continue;
                    foreach (string imported in ExpandStaticProjectPath(currentDir, importValue))
                    {
                        // Document ownership only needs shared item membership. Do not recursively evaluate arbitrary
                        // SDK/targets imports (which can contain properties and executable MSBuild semantics).
                        if (!string.Equals(Path.GetExtension(imported), ".projitems", StringComparison.OrdinalIgnoreCase)) continue;
                        if (File.Exists(imported)) pending.Enqueue(imported);
                    }
                }
            }
            return result;
        }

        private static IEnumerable<string> ExpandStaticProjectPath(string projectDir, string value)
        {
            string expanded = value.Replace("$(MSBuildThisFileDirectory)", projectDir + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
            if (expanded.Contains("$(") || expanded.Contains("@(") || expanded.Contains("%(")) yield break;
            string candidate = Path.IsPathRooted(expanded)
                ? Path.GetFullPath(expanded)
                : Path.GetFullPath(Path.Combine(projectDir, expanded.Replace('/', Path.DirectorySeparatorChar)));
            if (candidate.IndexOfAny(new[] { '*', '?' }) < 0)
            {
                yield return candidate;
                yield break;
            }
            string? dir = Path.GetDirectoryName(candidate);
            string pattern = Path.GetFileName(candidate);
            if (dir == null || !Directory.Exists(dir)) yield break;
            foreach (string match in Directory.EnumerateFiles(dir, pattern).Take(128)) yield return Path.GetFullPath(match);
        }

        private static bool ProjectItemMatches(string projectDir, string include, string fullFilePath)
        {
            include = include.Replace("$(MSBuildThisFileDirectory)", projectDir + Path.DirectorySeparatorChar,
                StringComparison.OrdinalIgnoreCase);
            if (include.IndexOfAny(new[] { '*', '?' }) >= 0
                || include.Contains("$(")
                || include.Contains("@(")
                || include.Contains("%("))
                return false;
            string candidate = Path.GetFullPath(Path.Combine(projectDir, include.Replace('/', Path.DirectorySeparatorChar)));
            return string.Equals(candidate, fullFilePath, StringComparison.OrdinalIgnoreCase);
        }

        private static bool IsInsideNestedProject(
            string projectDir,
            string fullProjectPath,
            string fullFilePath,
            IReadOnlyList<string> workspaceProjects)
        {
            foreach (string otherProject in workspaceProjects)
            {
                if (string.Equals(otherProject, fullProjectPath, StringComparison.OrdinalIgnoreCase)) continue;
                string? otherDir = Path.GetDirectoryName(otherProject);
                if (otherDir == null || !IsInsideProjectDir(projectDir, otherDir)) continue;
                if (IsInsideProjectDir(otherDir, fullFilePath)) return true;
            }
            return false;
        }

        private static bool IsInsideProjectDir(string projectDir, string fullFilePath)
        {
            string relative = Path.GetRelativePath(Path.GetFullPath(projectDir), fullFilePath);
            return relative.Length > 0 && !relative.StartsWith("..") && !Path.IsPathRooted(relative);
        }

        private static bool IsInBuildOutput(string projectDir, string fullFilePath)
        {
            string relative = Path.GetRelativePath(Path.GetFullPath(projectDir), fullFilePath)
                .Replace(Path.DirectorySeparatorChar, '/');
            return relative.StartsWith("bin/", StringComparison.OrdinalIgnoreCase)
                || relative.StartsWith("obj/", StringComparison.OrdinalIgnoreCase);
        }

        private static string? FreshestExisting(IReadOnlyList<string> candidates)
        {
            return candidates
                .Where(File.Exists)
                .Select(p => new FileInfo(p))
                .Where(f => IsProcessArchitectureCompatibleAssembly(f.FullName))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Select(f => f.FullName)
                .FirstOrDefault();
        }

        /// <summary>
        /// A project can retain outputs for several RIDs under one <c>bin/</c>. Freshness alone is not authority:
        /// after an ARM64 publish, an x64 designer used to select the newer ARM64 DLL, fail to load it, and quietly
        /// render a framework-only/near-empty canvas. Accept a real managed assembly only when its PE machine can load
        /// in this process. Pure IL AnyCPU remains portable; fixed-machine and 32-bit-required images must match.
        /// </summary>
        private static bool IsProcessArchitectureCompatibleAssembly(string path)
        {
            try
            {
                using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var pe = new PEReader(stream, PEStreamOptions.LeaveOpen);
                if (!pe.HasMetadata || pe.PEHeaders.CorHeader == null) return false;
                return IsMachineCompatible(pe.PEHeaders.CoffHeader.Machine, pe.PEHeaders.CorHeader.Flags,
                    RuntimeInformation.ProcessArchitecture);
            }
            catch
            {
                return false;
            }
        }

        internal static bool IsMachineCompatible(Machine machine, CorFlags flags, Architecture processArchitecture)
        {
            bool portableIl = machine == Machine.I386
                && (flags & CorFlags.ILOnly) != 0
                && (flags & CorFlags.Requires32Bit) == 0;
            if (portableIl) return true;

            return processArchitecture switch
            {
                Architecture.X86 => machine == Machine.I386,
                Architecture.X64 => machine == Machine.Amd64,
                Architecture.Arm => machine == Machine.ArmThumb2,
                Architecture.Arm64 => machine == Machine.Arm64,
                _ => false,
            };
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
        internal static readonly Regex NetCoreTfm =
            new(@"^net(\d+)\.(\d+)(?:-([a-z]+)[\d.]*)?$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        /// <summary>
        /// Pick the best TFM from a multi-target project's TargetFrameworks: among the HOST-LOADABLE
        /// modern .NET TFMs (clean net&lt;major&gt;.&lt;minor&gt; with major ≤ host), prefer the Windows
        /// variant (WinForms requires it) then the highest version. Returns null when none is loadable
        /// (all-legacy net4x / netstandard / higher-than-host), so the caller skips MSBuild and lets the
        /// bin-search fallback run rather than returning an assembly this runtime cannot load.
        /// </summary>
        internal static string? ChooseTfm(string targetFrameworks, int? hostMajor = null)
        {
            int loadableMajor = hostMajor ?? HostMajor;
            return targetFrameworks
                .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(t => (tfm: t, score: ScoreLoadable(t, loadableMajor)))
                .Where(x => x.score > 0)
                .OrderByDescending(x => x.score)
                .Select(x => x.tfm)
                .FirstOrDefault();
        }

        /// <summary>Score a host-loadable modern TFM (windows preferred, then version); 0 if not loadable.</summary>
        internal static long ScoreLoadable(string tfm, int? hostMajor = null)
        {
            var m = NetCoreTfm.Match(tfm);
            if (!m.Success)
            {
                return 0; // net48 / netstandard2.0 / netcoreapp3.1 — not a clean modern net TFM
            }
            int major = int.Parse(m.Groups[1].Value);
            int minor = int.Parse(m.Groups[2].Value);
            if (major > (hostMajor ?? HostMajor))
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
            // Prefer the freshest managed <asmName>.dll; fall back to the freshest <asmName>.exe ONLY when no .dll
            // exists. On .NET (Core/5+) the loadable assembly is always the .dll — the sibling .exe is a native
            // apphost launcher, and handing that apphost to a managed load / AssemblyDependencyResolver fails
            // ("an assembly … has already been found but with a different file extension"; the deps.json targets
            // the .dll), which silently empties the project-control toolbox. A naive freshest-of-{dll,exe} picks the
            // .exe whenever the apphost is stamped at/after the .dll (the common case), so we must not order across
            // the two extensions. The .exe fallback still covers a .NET Framework Exe output (whose .exe IS the
            // managed assembly, with no sibling .dll). Native apphosts and self-contained single-file launchers are
            // not loadable managed assemblies and are intentionally excluded by the PE/CLR-header filter below.
            string? Freshest(string ext) => Directory.EnumerateFiles(bin, asmName + ext, SearchOption.AllDirectories)
                .Select(p => new FileInfo(p))
                .Where(f => IsProcessArchitectureCompatibleAssembly(f.FullName))
                .OrderByDescending(f => f.LastWriteTimeUtc)
                .Select(f => f.FullName)
                .FirstOrDefault();
            return Freshest(".dll") ?? Freshest(".exe");
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
