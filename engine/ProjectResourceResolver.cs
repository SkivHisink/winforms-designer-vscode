using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Xml;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Read side of strongly typed project resources for the modern interpreter:
    /// <c>this.button1.Image = global::App.Properties.Resources.Logo;</c> and DevExpress's
    /// <c>this.saveButton.ImageOptions.SvgImage = global::App.Properties.Resources.add;</c>.
    ///
    /// The generated accessor is never executed. The expression is mapped to its .resx key through the same canonical
    /// Resources.Designer.cs check the resource picker uses for the write side, and the payload is read from that
    /// .resx: an inline base64 image, or a file reference that must stay inside the project directory (a rooted, UNC,
    /// drive-relative or reparse-point path is refused, so opening a form never reaches another machine). Only bitmaps,
    /// icons and SVG text are decoded, under the same size limits as form resources.
    ///
    /// The value must be the one the compiled form would get, or nothing: an image from another class is worse than a
    /// missing one. So the expression binds like C# — the innermost enclosing namespace that declares the class wins,
    /// whether that declaration is a resource designer file or only the build output — and the search never falls
    /// through to an outer namespace. Only the owning project is searched (a nested project's directory is skipped),
    /// two declarations of the same class are ambiguous, the accessor's ResourceManager base name must be the manifest
    /// name of the .resx beside it, and culture files overlay the neutral one for the form's preview culture. Anything
    /// that cannot be proven stays unrepresentable exactly as before; a proven accessor whose payload is missing or
    /// cannot be read safely evaluates to null and the property stays unset, mirroring <c>resources.GetObject</c>.
    /// </summary>
    internal sealed class ProjectResourceResolver
    {
        private const string SvgImageTypeName = "DevExpress.Utils.Svg.SvgImage";
        private const int MaxPayloadBytes = 16 * 1024 * 1024;
        private const long MaxTextFileBytes = 64L * 1024 * 1024;
        private const long MaxImagePixels = 4096L * 4096L;
        private const int MaxImageDimension = 20000;
        private const int MaxGifFrames = 256;
        private const int MaxIconEntries = 64;
        private const int MaxIconDimension = 1024;
        private const int MaxSvgElements = 10000;
        private const int MaxSvgDepth = 64;
        private const int MaxSvgUses = 256;
        private const long MaxSvgExpandedElements = 50000;
        private const int MaxProjectSearchDepth = 10;
        private const int MaxScanDepth = 12;
        private const int MaxScannedDirectories = 4000;
        private const int MaxScannedEntries = 200_000;
        private const int MaxEntriesPerDirectory = 20_000;

        private static readonly HashSet<string> ReadableTypes = new(StringComparer.Ordinal)
        {
            "System.Drawing.Image",
            "System.Drawing.Bitmap",
            "System.Drawing.Icon",
            SvgImageTypeName,
        };

        private static readonly HashSet<string> ProjectExtensions = new(StringComparer.OrdinalIgnoreCase)
        {
            ".csproj", ".vbproj", ".fsproj",
        };

        private static readonly HashSet<string> SkippedDirectories = new(StringComparer.OrdinalIgnoreCase)
        {
            "bin", "obj", "node_modules", "packages", "TestResults",
        };

        private readonly string _designerFilePath;
        private readonly string _namespace;
        private readonly string? _cultureName;
        private readonly IReadOnlyList<Assembly> _userAsms;
        private string? _projectDir;
        private bool _projectDirResolved;
        private ProjectManifestFacts? _manifestFacts;
        private bool _manifestFactsResolved;
        private List<string>? _resourcePairs;
        /// <summary>False once anything that could declare a resource class went unread: a scan limit, a skipped link
        /// or unreadable directory, or a resource pair whose accessor file exists but could not be read.</summary>
        private bool _knowledgeComplete = true;
        private readonly Dictionary<string, List<(string ResxPath, DesignerProjectResourcePicker.ResourceAccessorClass Class)>> _classesBySimpleName
            = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Dictionary<string, DesignerProjectResourcePicker.ResourcePayload?>?> _payloadsByPath
            = new(StringComparer.Ordinal);

        public ProjectResourceResolver(string designerFilePath, string designerNamespace, string? cultureName,
            IReadOnlyList<Assembly> userAsms)
        {
            _designerFilePath = designerFilePath;
            _namespace = designerNamespace ?? "";
            _cultureName = cultureName;
            _userAsms = userAsms;
        }

        /// <summary>True when <paramref name="receiver"/>.<paramref name="member"/> provably names a canonical strongly
        /// typed project resource; <paramref name="value"/> is then the decoded value, or null when the payload is
        /// missing or could not be read safely. False leaves the expression to the caller's existing
        /// (unrepresentable) handling.</summary>
        public bool TryResolve(string receiver, string member, Type? targetType, out object? value)
        {
            value = null;
            string text = new string((receiver ?? "").Where(c => !char.IsWhiteSpace(c)).ToArray());
            bool global = text.StartsWith("global::", StringComparison.Ordinal);
            if (global) text = text.Substring("global::".Length);
            string[] parts = text.Split('.');
            if (parts.Length == 0 || !parts.All(DesignerControlEditor.IsValidIdentifier)
                || !DesignerControlEditor.IsValidIdentifier(member)) return false;

            var declared = ClassesNamed(parts[^1]);
            foreach (string candidate in CandidateClassNames(text, global))
            {
                var matches = declared.Where(d => string.Equals(d.Class.ClassFullName, candidate, StringComparison.Ordinal)).ToList();
                if (matches.Count == 0)
                {
                    // C# binds the first candidate that exists at all. A class we can only see in the build output (an
                    // ordinary source file, a referenced library) stops the search rather than letting an outer
                    // namespace's resource stand in for it.
                    if (CompiledTypeExists(candidate)) return false;
                    // An unread part of the project may declare this class; an outer one must not stand in for it.
                    if (!_knowledgeComplete) return false;
                    continue;
                }
                if (matches.Count != 1 || !matches[0].Class.Canonical) return false;
                var (resxPath, cls) = matches[0];
                if (!cls.Accessors.TryGetValue(member, out var accessor)
                    || !ResourceManagerNamesThisResx(cls.ResourceManagerBaseName, resxPath)) return false;
                var payload = PayloadFor(resxPath, accessor.Key);
                value = payload != null && DesignerProjectResourcePicker.PayloadMatchesAccessor(payload.ValueTypeName, accessor.ValueTypeName)
                    ? Materialize(resxPath, payload, targetType)
                    : null;
                return true;
            }
            return false;
        }

        private bool CompiledTypeExists(string fullName)
        {
            foreach (var assembly in _userAsms)
            {
                try { if (assembly.GetType(fullName, throwOnError: false) != null) return true; }
                catch { /* an unreadable assembly declares nothing */ }
            }
            return false;
        }

        /// <summary>
        /// The generated ResourceManager reads the manifest resource its base name names, and MSBuild derives that name
        /// from the root namespace and the .resx path inside the project (folder names made valid identifiers). The
        /// name is reproduced here only where the project file proves it: a custom logical name, a re-pointed or removed
        /// resource, the SDK's DependentUpon convention (a same-named .cs beside the .resx) or an old-style project
        /// that does not list the file are all associations this reader cannot prove, and the expression stays
        /// unrepresentable.
        /// </summary>
        private bool ResourceManagerNamesThisResx(string baseName, string resxPath)
        {
            string? projectDir = ProjectDirectory();
            var facts = ManifestFacts();
            if (projectDir == null || facts?.RootNamespace == null || string.IsNullOrEmpty(baseName)) return false;
            string relative = Path.GetRelativePath(projectDir, resxPath);
            if (facts.AllOpaque || facts.OpaqueResx.Contains(relative)) return false;
            if (!facts.SdkStyle && !facts.ExplicitResx.Contains(relative)) return false;
            string stem = Path.GetFileNameWithoutExtension(resxPath);
            if (File.Exists(Path.Combine(Path.GetDirectoryName(resxPath)!, stem + ".cs"))) return false;
            string relativeDir = Path.GetDirectoryName(relative) ?? "";
            string folder = relativeDir.Length == 0 ? "" : EverettFolderName(relativeDir) + ".";
            return string.Equals(baseName, facts.RootNamespace + "." + folder + stem, StringComparison.Ordinal);
        }

        /// <summary>What the single project file proves about the names MSBuild gives its embedded resources.</summary>
        private sealed class ProjectManifestFacts
        {
            /// <summary>Null when the root namespace — and so every manifest name — cannot be proven.</summary>
            public string? RootNamespace;
            public bool SdkStyle;
            /// <summary>Project-relative paths of resources an old-style project lists explicitly.</summary>
            public readonly HashSet<string> ExplicitResx = new(StringComparer.OrdinalIgnoreCase);
            /// <summary>Resources removed from embedding or given a custom manifest name / DependentUpon owner.</summary>
            public readonly HashSet<string> OpaqueResx = new(StringComparer.OrdinalIgnoreCase);
            /// <summary>A wildcard removal or rename makes every resource's name unprovable.</summary>
            public bool AllOpaque;
        }

        private ProjectManifestFacts? ManifestFacts()
        {
            if (_manifestFactsResolved) return _manifestFacts;
            _manifestFactsResolved = true;
            try
            {
                string? projectDir = ProjectDirectory();
                if (projectDir == null) return null;
                var projects = Directory.GetFiles(projectDir, "*.csproj");
                if (projects.Length != 1) return null;
                byte[]? bytes = ReadProjectFile(projects[0], MaxTextFileBytes);
                if (bytes == null) return null;
                var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null };
                using var reader = XmlReader.Create(new MemoryStream(bytes), settings);
                var document = System.Xml.Linq.XDocument.Load(reader);
                var root = document.Root;
                if (root == null) return null;
                var elements = root.DescendantsAndSelf().ToList();
                var facts = new ProjectManifestFacts
                {
                    SdkStyle = root.Attribute("Sdk") != null
                        || elements.Any(e => e.Name.LocalName == "Sdk" || (e.Name.LocalName == "Import" && e.Attribute("Sdk") != null)),
                };

                foreach (var item in elements.Where(e => e.Name.LocalName == "EmbeddedResource"))
                {
                    bool removed = item.Attribute("Remove") != null;
                    bool renamed = item.Attribute("LogicalName") != null || item.Attribute("ManifestResourceName") != null
                        || item.Attribute("DependentUpon") != null
                        || item.Elements().Any(m => m.Name.LocalName is "LogicalName" or "ManifestResourceName" or "DependentUpon");
                    string spec = (string?)item.Attribute("Include") ?? (string?)item.Attribute("Update") ?? (string?)item.Attribute("Remove") ?? "";
                    foreach (string entry in spec.Split(';'))
                    {
                        string path = entry.Trim().Replace('/', Path.DirectorySeparatorChar);
                        if (path.Length == 0) continue;
                        bool pattern = path.IndexOfAny(new[] { '*', '?', '$', '%', '@' }) >= 0;
                        if (removed || renamed)
                        {
                            if (pattern) facts.AllOpaque = true;
                            else facts.OpaqueResx.Add(path);
                        }
                        else if (!pattern && item.Attribute("Include") != null) facts.ExplicitResx.Add(path);
                    }
                }

                var declared = elements.Where(e => e.Name.LocalName == "RootNamespace").Select(e => e.Value.Trim()).Distinct().ToList();
                string candidate = declared.Count switch
                {
                    // The SDK defaults the root namespace to the project name with spaces made underscores.
                    0 => facts.SdkStyle ? Path.GetFileNameWithoutExtension(projects[0]).Replace(' ', '_') : "",
                    1 => declared[0],
                    _ => "",
                };
                if (candidate.Length > 0 && candidate.Split('.').All(DesignerControlEditor.IsValidIdentifier)
                    && !BuildFilesOverrideResourceNaming(projectDir))
                    facts.RootNamespace = candidate;
                return _manifestFacts = facts;
            }
            catch { return _manifestFacts = null; }
        }

        /// <summary>The nearest Directory.Build.props/.targets above the project can set the root namespace or change
        /// how resources are embedded for every project below it; when it mentions either, nothing is proven. A file
        /// that is itself a link is not followed — it counts as an override, so nothing is proven either.</summary>
        private static bool BuildFilesOverrideResourceNaming(string projectDir)
        {
            foreach (string name in new[] { "Directory.Build.props", "Directory.Build.targets" })
            {
                for (var dir = new DirectoryInfo(projectDir); dir != null; dir = dir.Parent)
                {
                    var file = new FileInfo(Path.Combine(dir.FullName, name));
                    if (!file.Exists) continue;
                    if ((file.Attributes & FileAttributes.ReparsePoint) != 0 || file.Length > MaxTextFileBytes) return true;
                    string text = File.ReadAllText(file.FullName);
                    if (text.IndexOf("RootNamespace", StringComparison.OrdinalIgnoreCase) >= 0
                        || text.IndexOf("EmbeddedResource", StringComparison.OrdinalIgnoreCase) >= 0
                        || text.IndexOf("ManifestResourceName", StringComparison.OrdinalIgnoreCase) >= 0
                        || text.IndexOf("LogicalName", StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    break;
                }
            }
            return false;
        }

        /// <summary>MSBuild's manifest-name form of a project-relative folder path: each folder (and each dot-separated
        /// part of it) made a valid identifier — an invalid character becomes '_', an invalid first character gains a
        /// leading '_', and a lone "_" becomes "__".</summary>
        private static string EverettFolderName(string relativeDir)
        {
            var folders = relativeDir.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return string.Join(".", folders.Select(folder =>
            {
                string name = string.Join(".", folder.Split('.').Select(EverettSubFolderName));
                return name == "_" ? "__" : name;
            }));
        }

        private static string EverettSubFolderName(string part)
        {
            if (part.Length == 0) return part;
            var builder = new StringBuilder(part.Length + 1);
            if (IsEverettFirstChar(part[0])) builder.Append(part[0]);
            else
            {
                builder.Append('_');
                if (IsEverettChar(part[0])) builder.Append(part[0]);
            }
            for (int i = 1; i < part.Length; i++) builder.Append(IsEverettChar(part[i]) ? part[i] : '_');
            return builder.ToString();
        }

        private static bool IsEverettFirstChar(char c) =>
            char.IsLetter(c) || char.GetUnicodeCategory(c) == System.Globalization.UnicodeCategory.ConnectorPunctuation;

        private static bool IsEverettChar(char c) =>
            char.IsLetterOrDigit(c) || char.GetUnicodeCategory(c) is System.Globalization.UnicodeCategory.ConnectorPunctuation
                or System.Globalization.UnicodeCategory.NonSpacingMark
                or System.Globalization.UnicodeCategory.SpacingCombiningMark
                or System.Globalization.UnicodeCategory.EnclosingMark;

        /// <summary>The payload for <paramref name="key"/>: the neutral .resx overlaid by the parent and exact culture
        /// files of the form's preview culture. A culture entry that cannot be read shadows the neutral value, and a
        /// culture file that exists but cannot be parsed yields nothing rather than the neutral fallback.</summary>
        private DesignerProjectResourcePicker.ResourcePayload? PayloadFor(string resxPath, string key)
        {
            DesignerProjectResourcePicker.ResourcePayload? payload = null;
            foreach (string path in ResxChain(resxPath))
            {
                bool neutral = string.Equals(path, resxPath, StringComparison.OrdinalIgnoreCase);
                if (!neutral && !File.Exists(path)) continue;
                var payloads = Payloads(path);
                if (payloads == null) return null;
                if (payloads.TryGetValue(key, out var entry)) payload = entry;
            }
            return payload;
        }

        private IEnumerable<string> ResxChain(string resxPath)
        {
            yield return resxPath;
            if (!DesignerCultureSelection.TryNormalizeCultureName(_cultureName, out var normalized, out _) || normalized.Length == 0)
                yield break;
            var cultures = new Stack<System.Globalization.CultureInfo>();
            for (var c = System.Globalization.CultureInfo.GetCultureInfo(normalized);
                 !c.Equals(System.Globalization.CultureInfo.InvariantCulture); c = c.Parent)
                cultures.Push(c);
            string dir = Path.GetDirectoryName(resxPath)!;
            string stem = Path.GetFileNameWithoutExtension(resxPath);
            while (cultures.Count > 0) yield return Path.Combine(dir, stem + "." + cultures.Pop().Name + ".resx");
        }

        private Dictionary<string, DesignerProjectResourcePicker.ResourcePayload?>? Payloads(string path)
        {
            if (_payloadsByPath.TryGetValue(path, out var cached)) return cached;
            Dictionary<string, DesignerProjectResourcePicker.ResourcePayload?>? payloads = null;
            try
            {
                byte[]? bytes = ReadProjectFile(path, MaxTextFileBytes);
                if (bytes != null) payloads = DesignerProjectResourcePicker.ReadPayloads(DecodeText(bytes), ReadableTypes);
            }
            catch { payloads = null; }
            _payloadsByPath[path] = payloads;
            return payloads;
        }

        /// <summary>The C# lookup order for a namespace-relative name: innermost enclosing namespace first.</summary>
        private IEnumerable<string> CandidateClassNames(string name, bool global)
        {
            if (!global)
            {
                string ns = _namespace;
                while (ns.Length > 0)
                {
                    yield return ns + "." + name;
                    int dot = ns.LastIndexOf('.');
                    ns = dot < 0 ? "" : ns.Substring(0, dot);
                }
            }
            yield return name;
        }

        /// <summary>Every class named <paramref name="simpleName"/> declared by a <c>X.Designer.cs</c> beside an
        /// <c>X.resx</c> of the owning project.</summary>
        private List<(string ResxPath, DesignerProjectResourcePicker.ResourceAccessorClass Class)> ClassesNamed(string simpleName)
        {
            if (_classesBySimpleName.TryGetValue(simpleName, out var cached)) return cached;
            var found = new List<(string, DesignerProjectResourcePicker.ResourceAccessorClass)>();
            _classesBySimpleName[simpleName] = found;
            string? projectDir = ProjectDirectory();
            if (projectDir == null) return found;
            // The strongly typed resource generator names the class after the .resx, so only X.resx can declare X.
            if (_resourcePairs == null)
            {
                _resourcePairs = FindResx(projectDir, out bool complete);
                _knowledgeComplete &= complete;
            }
            foreach (string resxPath in _resourcePairs.Where(p =>
                string.Equals(Path.GetFileNameWithoutExtension(p), simpleName, StringComparison.Ordinal)))
            {
                try
                {
                    string accessorPath = Path.Combine(Path.GetDirectoryName(resxPath)!, simpleName + ".Designer.cs");
                    byte[]? accessors = ReadProjectFile(accessorPath, MaxTextFileBytes);
                    var classes = accessors == null ? null
                        : DesignerProjectResourcePicker.ReadAccessorClasses(DecodeText(accessors), simpleName, ReadableTypes);
                    if (classes == null)
                    {
                        // A pair without an accessor file declares nothing; one whose accessor exists but was not read
                        // may declare the very class the expression names.
                        if (File.Exists(accessorPath)) _knowledgeComplete = false;
                        continue;
                    }
                    foreach (var cls in classes) found.Add((resxPath, cls));
                }
                catch { _knowledgeComplete = false; }
            }
            return found;
        }

        /// <summary>The nearest directory, walking up from the designer file, that holds a .csproj.</summary>
        private string? ProjectDirectory()
        {
            if (_projectDirResolved) return _projectDir;
            _projectDirResolved = true;
            try
            {
                var dir = new DirectoryInfo(Path.GetDirectoryName(Path.GetFullPath(_designerFilePath)) ?? ".");
                for (int i = 0; dir != null && i < MaxProjectSearchDepth; i++, dir = dir.Parent)
                {
                    if (dir.EnumerateFiles("*.csproj").Any())
                    {
                        _projectDir = dir.FullName;
                        break;
                    }
                }
            }
            catch { _projectDir = null; }
            return _projectDir;
        }

        /// <summary>Every .resx of the owning project, found in ONE breadth-first walk per resolver (a form naming several
        /// resource classes used to walk the tree once per name). Breadth-first, so the conventional
        /// <c>Properties/</c> folder is reached long before a large subtree could exhaust the directory budget. Each
        /// directory is listed once; one holding its own project file belongs to that project — its resources are not
        /// this form's — and is not entered, nor is any link. A name ending in a dot or space is skipped: opened by
        /// path, the OS trims it and reaches a different entry than the one listed. A directory with more entries
        /// than one directory may list (a data or asset dump) is skipped rather than ending the walk, and the walk
        /// stops at a total entry budget, so millions of files cannot stall the render. <c>Properties/</c> is listed
        /// before its siblings, so no sibling can spend the budget first. <paramref name="complete"/> is false when
        /// any of that left a directory unread, other than build output, tool folders and nested projects.</summary>
        private static List<string> FindResx(string root, out bool complete)
        {
            complete = true;
            var results = new List<string>();
            var pending = new Queue<(DirectoryInfo Dir, int Depth)>();
            pending.Enqueue((new DirectoryInfo(root), 0));
            int scanned = 0, entriesLeft = MaxScannedEntries;
            while (pending.Count > 0 && scanned++ < MaxScannedDirectories && entriesLeft > 0)
            {
                var (dir, depth) = pending.Dequeue();
                try
                {
                    var entries = dir.EnumerateFileSystemInfos().Take(Math.Min(MaxEntriesPerDirectory, entriesLeft) + 1).ToList();
                    entriesLeft -= entries.Count;
                    bool overflow = entries.Count > MaxEntriesPerDirectory || entriesLeft < 0;
                    // A nested project's folder belongs to that project however large it is, so it is recognized
                    // before an oversized folder can make the walk incomplete.
                    if (depth > 0 && (entries.Any(e => e is FileInfo && ProjectExtensions.Contains(e.Extension))
                                      || (overflow && HoldsProjectFile(dir)))) continue;
                    if (overflow)
                    {
                        complete = false;
                        continue;
                    }
                    foreach (var entry in entries.OrderBy(e => e is DirectoryInfo && string.Equals(e.Name, "Properties", StringComparison.OrdinalIgnoreCase) ? 0 : 1))
                    {
                        bool isDirectory = entry is DirectoryInfo;
                        // Build output, tool folders and dot folders hold no resource class of this project.
                        if (isDirectory && (entry.Name.StartsWith(".", StringComparison.Ordinal) || SkippedDirectories.Contains(entry.Name))) continue;
                        bool mayDeclare = isDirectory || entry.Name.TrimEnd('.', ' ').EndsWith(".resx", StringComparison.OrdinalIgnoreCase);
                        if (entry.Name.EndsWith(".", StringComparison.Ordinal) || entry.Name.EndsWith(" ", StringComparison.Ordinal)
                            || (entry.Attributes & FileAttributes.ReparsePoint) != 0)
                        {
                            if (mayDeclare) complete = false;
                            continue;
                        }
                        if (!isDirectory)
                        {
                            if (mayDeclare) results.Add(entry.FullName);
                        }
                        else if (depth < MaxScanDepth) pending.Enqueue(((DirectoryInfo)entry, depth + 1));
                        else complete = false;
                    }
                }
                catch { complete = false; /* an unreadable directory contributes nothing */ }
            }
            if (pending.Count > 0) complete = false;
            return results;
        }

        /// <summary>Whether a folder too large to list holds a project file; only names are compared, nothing is opened.</summary>
        private static bool HoldsProjectFile(DirectoryInfo dir) =>
            ProjectExtensions.Any(extension => dir.EnumerateFiles("*" + extension)
                .Any(file => string.Equals(file.Extension, extension, StringComparison.OrdinalIgnoreCase)));

        private object? Materialize(string resxPath, DesignerProjectResourcePicker.ResourcePayload resource, Type? targetType)
        {
            try
            {
                byte[]? bytes = resource.StorageKind switch
                {
                    "bytearray" => DecodeInline(resource.RawValue),
                    "fileRef" => ReadReferencedFile(resxPath, resource.RawValue),
                    _ => null,
                };
                if (bytes == null) return null;
                return resource.ValueTypeName switch
                {
                    "System.Drawing.Image" or "System.Drawing.Bitmap" => DecodeBitmap(bytes),
                    "System.Drawing.Icon" => DecodeIcon(bytes),
                    SvgImageTypeName => DecodeSvg(bytes, targetType),
                    _ => null,
                };
            }
            catch { return null; }
        }

        private static byte[]? DecodeInline(string base64)
        {
            string compact = new string(base64.Where(c => !char.IsWhiteSpace(c)).ToArray());
            if (compact.Length == 0 || compact.Length > ((MaxPayloadBytes + 2) / 3) * 4) return null;
            byte[] bytes = Convert.FromBase64String(compact);
            return bytes.Length == 0 || bytes.Length > MaxPayloadBytes ? null : bytes;
        }

        /// <summary>Read a ResXFileRef target (<c>..\Resources\logo.png;System.Drawing.Bitmap, …</c>), which resolves
        /// against the .resx directory, through <see cref="ReadProjectFile"/>.</summary>
        private byte[]? ReadReferencedFile(string resxPath, string rawValue)
        {
            string relative = rawValue.Split(';')[0].Trim();
            if (relative.Length == 0 || relative.IndexOf(':') >= 0
                || Path.IsPathRooted(relative) || relative.StartsWith(@"\\", StringComparison.Ordinal)
                || relative.StartsWith("//", StringComparison.Ordinal)) return null;
            return ReadProjectFile(Path.Combine(Path.GetDirectoryName(resxPath)!, relative), MaxPayloadBytes);
        }

        /// <summary>
        /// Read a file only when it lies inside the project and no entry on its path BELOW the project root is a
        /// symbolic link or junction. The entries are checked top-down, each through its own attributes (which
        /// describe the link, not its target), so nothing beneath a link — possibly a UNC target that would receive the
        /// user's credentials — is ever queried, and the file itself is checked before its length or content is read.
        /// </summary>
        private byte[]? ReadProjectFile(string path, long maxBytes)
        {
            string? projectDir = ProjectDirectory();
            if (projectDir == null) return null;
            string root = Path.GetFullPath(projectDir).TrimEnd(Path.DirectorySeparatorChar);
            string full = Path.GetFullPath(path);
            // Ordinal: a directory can be case-sensitive, so a case-insensitive match could check one tree and read another.
            if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal)) return null;

            string current = root;
            foreach (string part in full.Substring(root.Length + 1).Split(Path.DirectorySeparatorChar))
            {
                if (part.Length == 0) return null;
                current = Path.Combine(current, part);
                // A name the OS would normalize (a trailing dot or space) checks one entry and opens another.
                if (!string.Equals(Path.GetFullPath(current), current, StringComparison.Ordinal)) return null;
                FileAttributes attributes;
                try { attributes = File.GetAttributes(current); }
                catch { return null; }
                if ((attributes & FileAttributes.ReparsePoint) != 0) return null;
                if (string.Equals(current, full, StringComparison.Ordinal)
                    && (attributes & FileAttributes.Directory) != 0) return null;
            }

            // Read exactly the name that was checked.
            var file = new FileInfo(current);
            if (file.Length == 0 || file.Length > maxBytes) return null;
            return File.ReadAllBytes(current);
        }

        /// <summary>
        /// Only the formats a project image resource really uses are decoded, and each is bounded from its own header
        /// BEFORE GDI+ sees it: with validateImageData the codec inflates the whole image first (a ~100 KB PNG declaring
        /// 5000x5000 cost ~100 MB), GDI+ parses every frame of a GIF on load (100 000 frames cost ~300 MB), and a small
        /// metafile can embed rasters far larger than its frame. PNG is checked from IHDR, GIF by walking its blocks,
        /// ICO by its directory; JPEG and BMP are decoded lazily and checked from the header GDI+ reads; TIFF, EMF, WMF
        /// and anything else are refused. The copy into a Bitmap then decodes only what passed (a corrupt body throws
        /// and the caller leaves the property unset).
        /// </summary>
        internal static Bitmap? DecodeBitmap(byte[] bytes)
        {
            bool allowed = Signature(bytes) switch
            {
                RasterKind.Png => PngIsBounded(bytes),
                RasterKind.Gif => GifIsBounded(bytes),
                RasterKind.Ico => IcoIsBounded(bytes),
                RasterKind.Jpeg or RasterKind.Bmp => true,
                _ => false,
            };
            if (!allowed) return null;
            using var ms = new MemoryStream(bytes);
            using var img = Image.FromStream(ms, useEmbeddedColorManagement: false, validateImageData: false);
            if (img is System.Drawing.Imaging.Metafile) return null;
            return HasSafeDimensions(img.Width, img.Height) ? new Bitmap(img) : null;
        }

        internal static Icon? DecodeIcon(byte[] bytes)
        {
            if (Signature(bytes) != RasterKind.Ico || !IcoIsBounded(bytes)) return null;
            using var ms = new MemoryStream(bytes);
            using var icon = new Icon(ms);
            return HasSafeDimensions(icon.Width, icon.Height) ? (Icon)icon.Clone() : null;
        }

        private static bool HasSafeDimensions(int width, int height) =>
            width > 0 && height > 0 && width <= MaxImageDimension && height <= MaxImageDimension
            && (long)width * height <= MaxImagePixels;

        private enum RasterKind { Other, Png, Gif, Jpeg, Bmp, Ico }

        private static RasterKind Signature(byte[] b)
        {
            if (b.Length >= 8 && b[0] == 0x89 && b[1] == (byte)'P' && b[2] == (byte)'N' && b[3] == (byte)'G'
                && b[4] == 0x0D && b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A) return RasterKind.Png;
            if (b.Length >= 6 && b[0] == (byte)'G' && b[1] == (byte)'I' && b[2] == (byte)'F' && b[3] == (byte)'8'
                && (b[4] == (byte)'7' || b[4] == (byte)'9') && b[5] == (byte)'a') return RasterKind.Gif;
            if (b.Length >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF) return RasterKind.Jpeg;
            if (b.Length >= 2 && b[0] == (byte)'B' && b[1] == (byte)'M') return RasterKind.Bmp;
            if (b.Length >= 4 && b[0] == 0 && b[1] == 0 && b[2] == 1 && b[3] == 0) return RasterKind.Ico;
            return RasterKind.Other;
        }

        private static int BigEndian32(byte[] b, int offset) =>
            b[offset] << 24 | b[offset + 1] << 16 | b[offset + 2] << 8 | b[offset + 3];

        /// <summary>IHDR is the first chunk: length(4) "IHDR"(4) width(4) height(4), big-endian.</summary>
        private static bool PngIsBounded(byte[] b) =>
            b.Length >= 24 && b[12] == (byte)'I' && b[13] == (byte)'H' && b[14] == (byte)'D' && b[15] == (byte)'R'
            && HasSafeDimensions(BigEndian32(b, 16), BigEndian32(b, 20));

        /// <summary>Walks the GIF block structure: the logical screen and every frame must be within the pixel limit,
        /// and there may be at most <see cref="MaxGifFrames"/> frames. A malformed structure is refused.</summary>
        private static bool GifIsBounded(byte[] b)
        {
            if (b.Length < 13 || !HasSafeDimensions(b[6] | b[7] << 8, b[8] | b[9] << 8)) return false;
            long pos = 13;
            if ((b[10] & 0x80) != 0) pos += 3 << ((b[10] & 7) + 1);
            int frames = 0;
            while (pos < b.Length)
            {
                byte block = b[pos++];
                if (block == 0x3B) return frames > 0;
                if (block == 0x21)
                {
                    pos++; // extension label
                    if (!SkipGifSubBlocks(b, ref pos)) return false;
                    continue;
                }
                if (block != 0x2C || ++frames > MaxGifFrames || pos + 9 > b.Length) return false;
                int width = b[pos + 4] | b[pos + 5] << 8, height = b[pos + 6] | b[pos + 7] << 8;
                if (!HasSafeDimensions(Math.Max(width, 1), Math.Max(height, 1))) return false;
                byte flags = b[pos + 8];
                pos += 9;
                if ((flags & 0x80) != 0) pos += 3 << ((flags & 7) + 1);
                pos++; // LZW minimum code size
                if (!SkipGifSubBlocks(b, ref pos)) return false;
            }
            return frames > 0;
        }

        private static bool SkipGifSubBlocks(byte[] b, ref long pos)
        {
            while (pos < b.Length)
            {
                int size = b[pos++];
                if (size == 0) return true;
                pos += size;
            }
            return false;
        }

        /// <summary>Every directory entry must lie inside the file and declare an image of at most
        /// <see cref="MaxIconDimension"/> pixels a side — from the embedded PNG's IHDR or the BITMAPINFOHEADER, whose
        /// height counts the XOR and AND masks twice. The directory bytes alone are not trusted.</summary>
        private static bool IcoIsBounded(byte[] b)
        {
            if (b.Length < 6 || (b[2] != 1 && b[2] != 2)) return false;
            int count = b[4] | b[5] << 8;
            if (count == 0 || count > MaxIconEntries || 6 + 16 * count > b.Length) return false;
            for (int i = 0; i < count; i++)
            {
                int entry = 6 + 16 * i;
                long size = BitConverter.ToUInt32(b, entry + 8), offset = BitConverter.ToUInt32(b, entry + 12);
                if (size < 24 || offset + size > b.Length) return false;
                int o = (int)offset;
                int width, height;
                if (b[o] == 0x89 && b[o + 1] == (byte)'P' && b[o + 2] == (byte)'N' && b[o + 3] == (byte)'G')
                {
                    width = BigEndian32(b, o + 16);
                    height = BigEndian32(b, o + 20);
                }
                else if (BitConverter.ToUInt32(b, o) == 12)
                {
                    // BITMAPCOREHEADER: 16-bit width and height.
                    width = BitConverter.ToUInt16(b, o + 4);
                    height = BitConverter.ToUInt16(b, o + 6) / 2;
                }
                else if (size >= 40)
                {
                    // BITMAPINFOHEADER; a negative height is a top-down image of the same size.
                    width = BitConverter.ToInt32(b, o + 4);
                    height = Math.Abs(BitConverter.ToInt32(b, o + 8) / 2);
                }
                else return false;
                if (width <= 0 || height <= 0 || width > MaxIconDimension || height > MaxIconDimension) return false;
            }
            return true;
        }

        /// <summary>Parse SVG TEXT with the vendor's own <c>SvgImage.FromStream</c>. The bytes must first parse as an
        /// <c>&lt;svg&gt;</c> document without a DTD — a serialized (BinaryFormatter) SvgImage, or a document declaring
        /// entities in any encoding, is refused before any vendor code sees it — and the type must be DevExpress's,
        /// preferably the very type the target property declares.</summary>
        private object? DecodeSvg(byte[] bytes, Type? targetType)
        {
            bytes = WithoutDocumentType(bytes)!;
            if (bytes == null || !IsSafeSvgDocument(bytes)) return null;

            Type? svgType = targetType != null && targetType.FullName == SvgImageTypeName
                && DesignerAllowlists.IsDevExpressAssembly(targetType.Assembly)
                ? targetType
                : _userAsms.Where(DesignerAllowlists.IsDevExpressAssembly)
                    .Select(a => a.GetType(SvgImageTypeName, throwOnError: false))
                    .FirstOrDefault(t => t != null);
            var fromStream = svgType?.GetMethod("FromStream", BindingFlags.Public | BindingFlags.Static, null,
                new[] { typeof(Stream) }, null);
            if (svgType == null || fromStream == null || fromStream.ReturnType != svgType) return null;
            return fromStream.Invoke(null, new object[] { new MemoryStream(bytes) });
        }

        /// <summary>
        /// The document re-serialized as UTF-8 without its DOCTYPE, which is what the vendor parser then receives.
        /// Illustrator and the DevExpress gallery emit the standard external SVG 1.1 declaration; it is dropped
        /// unread — the reader ignores DTDs and resolves nothing — so no DTD ever reaches the vendor, and an entity the
        /// DTD would have declared is an undeclared reference that refuses the whole image. The text is decoded the
        /// way the vendor decodes it — UTF-8 unless a byte order mark says otherwise, whatever the XML declaration
        /// names — so a document declared in another encoding renders exactly as it would have at run time. Null when
        /// the bytes are not well-formed XML.
        /// </summary>
        internal static byte[]? WithoutDocumentType(byte[] bytes)
        {
            try
            {
                var settings = new XmlReaderSettings
                {
                    DtdProcessing = DtdProcessing.Ignore,
                    XmlResolver = null,
                    MaxCharactersInDocument = MaxPayloadBytes,
                };
                using var text = new StreamReader(new MemoryStream(bytes), new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true);
                using var reader = XmlReader.Create(text, settings);
                using var output = new MemoryStream();
                using (var writer = XmlWriter.Create(output, new XmlWriterSettings { Encoding = new UTF8Encoding(false) }))
                {
                    // Past the declaration, DOCTYPE, comments and whitespace to the root, which is copied whole.
                    if (reader.MoveToContent() != XmlNodeType.Element) return null;
                    writer.WriteNode(reader, defattr: false);
                }
                // The rest of the document must still be well-formed (only comments or whitespace may follow).
                while (reader.Read()) { }
                return output.ToArray();
            }
            catch { return null; }
        }

        private sealed class SvgNode
        {
            /// <summary>This element and its descendants.</summary>
            public long Elements = 1;
            /// <summary>The ids every &lt;use&gt; in this subtree instantiates.</summary>
            public readonly List<string> Uses = new();
        }

        /// <summary>
        /// The same byte stream the vendor will read, parsed first by a reader that prohibits DTDs and resolves nothing;
        /// it detects the encoding itself, so a BOM-less UTF-16 document cannot hide a DOCTYPE. The document must also
        /// stay small enough for the vendor's recursive renderer: DevExpress expands every &lt;use&gt; into its target, so
        /// a reference cycle (<c>&lt;g id='g'&gt;&lt;use href='#g'/&gt;&lt;/g&gt;</c>) overflows the stack and kills the
        /// engine process, and a chain of doubling references multiplies the work exponentially. Element count, depth,
        /// number of references and the fully expanded size are therefore bounded, and any cycle is refused.
        /// </summary>
        internal static bool IsSafeSvgDocument(byte[] bytes)
        {
            try
            {
                var settings = new XmlReaderSettings
                {
                    DtdProcessing = DtdProcessing.Prohibit,
                    XmlResolver = null,
                    MaxCharactersInDocument = MaxPayloadBytes,
                };
                using var reader = XmlReader.Create(new MemoryStream(bytes), settings);
                var open = new Stack<SvgNode>();
                // Real icons repeat ids (two of the DevExpress gallery's 3063 do); a reference is assumed to reach
                // every element carrying the id, which over-counts the expansion but never misses a cycle.
                var byId = new Dictionary<string, List<SvgNode>>(StringComparer.Ordinal);
                SvgNode? root = null;
                int elements = 0, uses = 0;
                void Close(SvgNode node)
                {
                    if (open.Count == 0) return;
                    var parent = open.Peek();
                    parent.Elements += node.Elements;
                    parent.Uses.AddRange(node.Uses);
                }
                while (reader.Read())
                {
                    if (reader.NodeType == XmlNodeType.EndElement)
                    {
                        if (open.Count > 0) Close(open.Pop());
                        continue;
                    }
                    if (reader.NodeType != XmlNodeType.Element) continue;
                    if (root == null && reader.LocalName != "svg") return false;
                    if (++elements > MaxSvgElements || open.Count >= MaxSvgDepth) return false;
                    var node = new SvgNode();
                    root ??= node;
                    string? id = reader.GetAttribute("id");
                    if (!string.IsNullOrEmpty(id))
                    {
                        if (!byId.TryGetValue(id, out var sameId)) byId[id] = sameId = new List<SvgNode>();
                        sameId.Add(node);
                    }
                    if (reader.LocalName == "use")
                    {
                        if (++uses > MaxSvgUses) return false;
                        string? href = reader.GetAttribute("href", "http://www.w3.org/1999/xlink") ?? reader.GetAttribute("href");
                        if (href is { Length: > 1 } && href[0] == '#') node.Uses.Add(href.Substring(1));
                    }
                    if (reader.IsEmptyElement) Close(node);
                    else open.Push(node);
                }
                if (root == null) return false;

                var expanded = new Dictionary<SvgNode, long>(ReferenceEqualityComparer.Instance);
                var visiting = new HashSet<SvgNode>(ReferenceEqualityComparer.Instance);
                long Expand(SvgNode node)
                {
                    if (expanded.TryGetValue(node, out long known)) return known;
                    if (!visiting.Add(node)) throw new InvalidDataException("svg reference cycle");
                    long total = node.Elements;
                    foreach (string target in node.Uses)
                    {
                        if (!byId.TryGetValue(target, out var referenced)) continue;
                        foreach (var each in referenced)
                        {
                            total += Expand(each);
                            if (total > MaxSvgExpandedElements) throw new InvalidDataException("svg expands too far");
                        }
                    }
                    visiting.Remove(node);
                    expanded[node] = total;
                    return total;
                }
                return Expand(root) <= MaxSvgExpandedElements;
            }
            catch { return false; }
        }

        private static string DecodeText(byte[] bytes)
        {
            using var reader = new StreamReader(new MemoryStream(bytes), new UTF8Encoding(false), detectEncodingFromByteOrderMarks: true);
            return reader.ReadToEnd();
        }
    }
}
