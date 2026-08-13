using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.Loader;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Collectible load context for the user's compiled control assembly.
    /// Shared contract assemblies (WinForms / Drawing / corelib / protocol DTO) are
    /// resolved from the Default ALC by returning null in Load — this keeps a SINGLE
    /// type identity so a user control's base (e.g. UserControl) is the same Type the
    /// host designer uses (avoids "X cannot be converted to X").
    ///
    /// Private dependencies of the user assembly (resolved via its deps.json) are loaded
    /// into THIS context so they can be unloaded with it.
    ///
    /// NEVER PINS THE USER'S BUILD OUTPUT. Every assembly here is loaded from a private in-memory copy
    /// (<see cref="LoadNoLock"/>) rather than with LoadFromAssemblyPath, because LoadFromAssemblyPath maps the file
    /// and holds an OS handle on it until the whole context is collected — which made the user's OWN build fail with
    ///   MSB3027: Could not copy "obj\...\App.exe" to "bin\...\App.exe" — The file is locked by "WinFormsDesigner.Engine"
    /// for as long as this engine process lived. Unload() was not a fix: it only *starts* an unload, the handle
    /// survives until a GC actually collects the context, and a context whose types reached TypeDescriptor / a
    /// DesignSurface is typically never collectible at all. A .NET Framework (net4x) output made it worse — the load
    /// SUCCEEDS on .NET Core (only type resolution fails later), so a net48 project's .exe got pinned by the modern
    /// engine even though it can never render it. Reading the bytes takes no lasting handle, so the user can rebuild
    /// at any moment, with no release command, no focus-loss dance and no engine recycle.
    /// </summary>
    public sealed class ControlLoadContext : AssemblyLoadContext
    {
        private readonly AssemblyDependencyResolver _resolver;
        private readonly string[] _probeDirectories;

        /// <summary>Assembly → the file it was loaded FROM. A byte-loaded assembly reports an EMPTY
        /// <see cref="Assembly.Location"/>, and the Choose-Items dialog shows a candidate's on-disk directory, so the
        /// origin is remembered here instead. Weak keys: an entry dies with its assembly.</summary>
        private static readonly ConditionalWeakTable<Assembly, string> _origins = new();

        public ControlLoadContext(string mainAssemblyPath, IEnumerable<string>? probeDirectories = null)
            : base(name: "winforms-controls", isCollectible: true)
        {
            _resolver = new AssemblyDependencyResolver(mainAssemblyPath);
            _probeDirectories = (probeDirectories ?? Array.Empty<string>())
                .Where(dir => !string.IsNullOrWhiteSpace(dir) && Directory.Exists(dir))
                .Select(Path.GetFullPath)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            if (IsSharedName(assemblyName.Name))
            {
                return null; // defer to Default ALC -> single shared identity
            }
            string? path = _resolver.ResolveAssemblyToPath(assemblyName);
            if (path != null) return LoadNoLock(path);
            string? simple = assemblyName.Name;
            if (string.IsNullOrWhiteSpace(simple) || !string.Equals(Path.GetFileName(simple), simple, StringComparison.Ordinal))
                return null;
            foreach (var dir in _probeDirectories)
            {
                string candidate = Path.Combine(dir, simple + ".dll");
                if (File.Exists(candidate)) return LoadNoLock(candidate);
            }
            return null;
        }

        /// <summary>
        /// Load an assembly into this context from a private in-memory copy, taking NO lasting handle on the file —
        /// the whole point of this class (see the type remarks: LoadFromAssemblyPath pins the user's build output and
        /// breaks their next build with MSB3027). Use this for EVERY user-owned file; it is the only load entry point
        /// this engine should call.
        ///
        /// Opened with FileShare.ReadWrite|Delete so a read that races the user's build reads rather than throwing a
        /// sharing violation; a torn read then surfaces as the BadImageFormatException callers already handle.
        /// </summary>
        public Assembly LoadNoLock(string path)
        {
            string full = Path.GetFullPath(path);
            byte[] bytes = ReadSharedBytes(full);
            using var image = new MemoryStream(bytes, writable: false);
            var asm = LoadFromStream(image);
            // AddOrUpdate, not Add: the same file can legitimately be requested twice (probe + explicit sibling scan),
            // and Add would throw on the second registration.
            _origins.AddOrUpdate(asm, full);
            return asm;
        }

        /// <summary>The file an assembly was loaded from: the recorded origin for a byte-loaded (no-lock) assembly,
        /// else its real <see cref="Assembly.Location"/> for anything from the Default ALC. "" when neither is known
        /// (a dynamic assembly), which is exactly what Location used to return there.</summary>
        public static string OriginOf(Assembly? asm)
        {
            if (asm == null) return "";
            if (_origins.TryGetValue(asm, out var origin)) return origin;
            try { return asm.Location ?? ""; } catch { return ""; }
        }

        private static byte[] ReadSharedBytes(string path)
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var buffer = new MemoryStream();
            fs.CopyTo(buffer);
            return buffer.ToArray();
        }

        /// <summary>Native dependencies are still loaded IN PLACE: an unmanaged dll has no in-memory load form, and
        /// copying one aside would break its own sibling/manifest probing. It only pins a file when a design-time
        /// constructor actually P/Invokes into a project-local native library — unlike the managed graph, which was
        /// pinned on every render. A project in that shape can still need "Restart the Designer Preview Engine"
        /// before it can replace THAT dll; the managed output it builds beside it is free either way.</summary>
        protected override IntPtr LoadUnmanagedDll(string unmanagedDllName)
        {
            string? path = _resolver.ResolveUnmanagedDllToPath(unmanagedDllName);
            return path != null ? LoadUnmanagedDllFromPath(path) : IntPtr.Zero;
        }

        public static bool IsSharedName(string? name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            return name == "mscorlib"
                || name == "netstandard"
                || name == "WindowsBase"
                || name == "System.Private.CoreLib"
                || name == "WinFormsDesigner.Protocol"
                || name.StartsWith("System.", StringComparison.Ordinal)
                || name.StartsWith("Microsoft.Win32.", StringComparison.Ordinal)
                || name.StartsWith("Microsoft.CSharp", StringComparison.Ordinal)
                || name.StartsWith("Microsoft.VisualBasic", StringComparison.Ordinal);
        }
    }
}
