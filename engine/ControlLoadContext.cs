using System;
using System.Reflection;
using System.Runtime.Loader;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Collectible load context for the user's compiled control assembly (plan §8.3).
    /// Shared contract assemblies (WinForms / Drawing / corelib / protocol DTO) are
    /// resolved from the Default ALC by returning null in Load — this keeps a SINGLE
    /// type identity so a user control's base (e.g. UserControl) is the same Type the
    /// host designer uses (avoids "X cannot be converted to X").
    ///
    /// Private dependencies of the user assembly (resolved via its deps.json) are loaded
    /// into THIS context so they can be unloaded with it.
    /// </summary>
    public sealed class ControlLoadContext : AssemblyLoadContext
    {
        private readonly AssemblyDependencyResolver _resolver;

        public ControlLoadContext(string mainAssemblyPath)
            : base(name: "winforms-controls", isCollectible: true)
        {
            _resolver = new AssemblyDependencyResolver(mainAssemblyPath);
        }

        protected override Assembly? Load(AssemblyName assemblyName)
        {
            if (IsSharedName(assemblyName.Name))
            {
                return null; // defer to Default ALC -> single shared identity
            }
            string? path = _resolver.ResolveAssemblyToPath(assemblyName);
            return path != null ? LoadFromAssemblyPath(path) : null;
        }

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
