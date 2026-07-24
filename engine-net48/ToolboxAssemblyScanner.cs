using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Reflection-only-in-spirit Choose Items scanner hosted in a short-lived AppDomain. It never instantiates a user
    /// type or materializes attributes; after the serializable rows cross back, the caller unloads the domain so a
    /// browsed/project/GAC assembly is not left pinned and cannot break the user's next build.
    /// </summary>
    public sealed class ToolboxAssemblyScanner : MarshalByRefObject
    {
        private string[] _probeDirectories = Array.Empty<string>();

#pragma warning disable CS0672 // net48 MarshalByRefObject lifetime hook is intentionally used
        public override object InitializeLifetimeService() => null!;
#pragma warning restore CS0672

        public ToolboxScanResult Scan(string assemblyPath, string[]? probeDirectories)
        {
            string simpleName = string.IsNullOrWhiteSpace(assemblyPath) ? "" : Path.GetFileNameWithoutExtension(assemblyPath);
            if (string.IsNullOrWhiteSpace(assemblyPath) || !File.Exists(assemblyPath))
                return new ToolboxScanResult { AssemblyName = simpleName, Error = "file not found" };

            string full = Path.GetFullPath(assemblyPath);
            _probeDirectories = new[] { Path.GetDirectoryName(full) ?? "" }
                .Concat(probeDirectories ?? Array.Empty<string>())
                .Where(p => !string.IsNullOrWhiteSpace(p) && Directory.Exists(p))
                .Select(Path.GetFullPath)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();

            ResolveEventHandler resolver = (_, args) => ResolveDependency(args.Name);
            AppDomain.CurrentDomain.AssemblyResolve += resolver;
            try
            {
                var asm = Assembly.LoadFrom(full);
                var an = asm.GetName();
                Type[] types;
                string? warning = null;
                try { types = asm.GetTypes(); }
                catch (ReflectionTypeLoadException ex)
                {
                    types = ex.Types.Where(t => t != null).ToArray()!;
                    warning = "some types could not be loaded (missing dependencies)";
                }

                var items = new List<ToolboxCandidate>();
                foreach (var type in types)
                {
                    if (type == null) continue;
                    try
                    {
                        if (!IsEligible(type)) continue;
                        items.Add(new ToolboxCandidate
                        {
                            Name = type.Name,
                            Namespace = type.Namespace ?? "",
                            AssemblyName = an.Name ?? simpleName,
                            Version = an.Version?.ToString() ?? "",
                            Directory = Path.GetDirectoryName(full) ?? "",
                            FromProject = true,
                            AssemblyPath = full,
                        });
                    }
                    catch { /* one hostile/partially-loadable type must not hide the rest of the assembly */ }
                }

                var distinct = items
                    .GroupBy(i => i.Namespace + "." + i.Name, StringComparer.Ordinal)
                    .Select(g => g.First())
                    .OrderBy(i => i.Name, StringComparer.Ordinal)
                    .ToArray();
                return new ToolboxScanResult
                {
                    AssemblyName = an.Name ?? simpleName,
                    Items = distinct,
                    Error = distinct.Length == 0 ? (warning ?? "no toolbox-eligible controls or components") : warning,
                };
            }
            catch (BadImageFormatException)
            {
                return new ToolboxScanResult { AssemblyName = simpleName, Error = "not a .NET assembly (or wrong architecture)" };
            }
            catch (Exception ex)
            {
                return new ToolboxScanResult { AssemblyName = simpleName, Error = ex.GetBaseException().Message };
            }
            finally
            {
                AppDomain.CurrentDomain.AssemblyResolve -= resolver;
            }
        }

        private Assembly? ResolveDependency(string displayName)
        {
            string file;
            try { file = new AssemblyName(displayName).Name + ".dll"; }
            catch { return null; }
            foreach (var dir in _probeDirectories)
            {
                string candidate = Path.Combine(dir, file);
                try { if (File.Exists(candidate)) return Assembly.LoadFrom(candidate); } catch { /* try next probe */ }
            }
            return null;
        }

        private static bool IsEligible(Type type)
        {
            if (!type.IsPublic || !type.IsClass || type.IsAbstract || type.IsGenericTypeDefinition || type.IsNested)
                return false;
            if (string.IsNullOrEmpty(type.FullName) || type.FullName!.IndexOf('+') >= 0) return false;
            if (!typeof(IComponent).IsAssignableFrom(type)) return false;
            if (typeof(Form).IsAssignableFrom(type) || typeof(ToolStripDropDown).IsAssignableFrom(type)) return false;
            if (IsDisabled(type, "ToolboxItemAttribute") || IsDisabled(type, "DesignTimeVisibleAttribute")) return false;
            if (typeof(Control).IsAssignableFrom(type))
            {
                if (type.GetConstructor(Type.EmptyTypes) == null) return false;
                if (type.Name == "Control" || type.Name == "ContainerControl" || type.Name == "ScrollableControl"
                    || type.Name == "UserControl" || type.Name.EndsWith("EditingControl", StringComparison.Ordinal))
                    return false;
                return true;
            }
            return type.GetConstructor(Type.EmptyTypes) != null
                || type.GetConstructor(new[] { typeof(IContainer) }) != null;
        }

        private static bool IsDisabled(Type type, string attributeName)
        {
            foreach (var attr in type.GetCustomAttributesData())
            {
                if (!string.Equals(attr.AttributeType.Name, attributeName, StringComparison.Ordinal)) continue;
                if (attr.ConstructorArguments.Count == 1 && attr.ConstructorArguments[0].Value is bool enabled)
                    return !enabled;
            }
            return false;
        }
    }
}
