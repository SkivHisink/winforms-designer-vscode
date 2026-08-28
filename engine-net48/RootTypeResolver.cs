using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using WinFormsDesigner.Engine;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Derives the fully-qualified control type name from a .Designer.cs (or its main .cs) so the worker can
    /// find the compiled type. Runs in the HOST domain (keeps Roslyn out of the render child domain). Handles
    /// block + file-scoped namespaces and nested types.
    /// </summary>
    public static class RootTypeResolver
    {
        private sealed class ReferenceSnapshot
        {
            public long Length { get; set; }
            public long LastWriteTicks { get; set; }
            public PortableExecutableReference Reference { get; set; } = null!;
        }

        private static readonly object ReferenceLock = new object();
        private static readonly Dictionary<string, ReferenceSnapshot> ReferenceCache =
            new Dictionary<string, ReferenceSnapshot>(StringComparer.OrdinalIgnoreCase);

        /// <summary>The form's fully-qualified type name, or "" when the file declares no single designer class —
        /// which the caller turns into a hard error (banner), never a guess.</summary>
        public static string Resolve(string designerFilePath)
        {
            string code = File.ReadAllText(designerFilePath);
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            // THE shared form-class rule — NOT "the first class in the file", which is what this used to take. A
            // .Designer.cs holding a helper class ahead of the form made this host instantiate and preview the
            // HELPER, with no banner, while the net9 host spliced edits into the form: preview one class, edit
            // another. Ambiguous/absent → "" → the caller fails closed. (FormClassResolver is compile-linked from
            // the net9 engine, so the two hosts cannot drift apart.)
            var cls = FormClassResolver.FormClass(root);
            if (cls == null) return "";

            // The runtime name comes from the SHARED identity too — it is already reflection's own format
            // (Ns.Outer+Inner, generic arity `N). This used to rebuild the name here and got it subtly wrong twice
            // over: it walked only ClassDeclarationSyntax outers (so a form nested in a `record`/`struct` shell lost
            // that segment) and dropped generic arity entirely. The result was a name Type lookup can't find — which
            // the worker's simple-name fallback then "rescued" by instantiating whatever unique control shared the
            // short name, i.e. a different form rendered as yours. One identity, one place.
            return FormClassResolver.QualifiedName(cls);
        }

        /// <summary>
        /// Resolve the base class declared by the CURRENT source, preferring the supplied (possibly unsaved)
        /// designer buffer and then the ordinary sibling code-behind partial. An empty result is deliberately
        /// "not proven": inherited override capabilities must be withheld because the compiled base cannot be
        /// shown to describe the source the user is editing.
        /// </summary>
        public static string ResolveDeclaredBase(string designerFilePath, string? designerSource = null,
            string? codeBehindSource = null, string? assemblyPath = null, string[]? probeDirs = null)
        {
            try
            {
                string code = designerSource ?? File.ReadAllText(designerFilePath);
                var designerTree = CSharpSyntaxTree.ParseText(code, path: designerFilePath);
                var root = designerTree.GetRoot();
                var cls = FormClassResolver.FormClass(root);
                if (cls == null) return "";

                string identity = FormClassResolver.QualifiedName(cls);
                var trees = new List<SyntaxTree> { designerTree };
                var declarations = new List<(TypeSyntax Type, SyntaxTree Tree)>();
                TypeSyntax? designerBase = DeclaredBaseOf(cls);
                if (designerBase != null) declarations.Add((designerBase, designerTree));

                string siblingPath = CodeBehindPath(designerFilePath);
                // A supplied empty buffer is authoritative: the user may have deleted the entire sibling file but
                // not saved it yet. Falling back to disk in that case would validate the previous base and reopen
                // stale inherited capabilities.
                string? siblingCode = codeBehindSource;
                if (siblingCode == null && siblingPath.Length > 0 && File.Exists(siblingPath))
                    siblingCode = File.ReadAllText(siblingPath);
                if (siblingCode != null)
                {
                    var siblingTree = CSharpSyntaxTree.ParseText(siblingCode, path: siblingPath);
                    trees.Add(siblingTree);
                    var matchingParts = siblingTree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>()
                        .Where(candidate => FormClassResolver.QualifiedName(candidate) == identity)
                        .ToList();
                    if (matchingParts.Count == 0) return "";
                    declarations.AddRange(matchingParts
                        .Select(DeclaredBaseOf)
                        .Where(candidate => candidate != null)
                        .Cast<TypeSyntax>()
                        .Select(candidate => (candidate, (SyntaxTree)siblingTree)));
                }
                if (declarations.Count == 0) return "";

                var canonicalBases = new HashSet<string>(StringComparer.Ordinal);
                foreach (var declaration in declarations)
                {
                    string canonical = ResolveSemanticBase(declaration.Type, declaration.Tree, trees, assemblyPath, probeDirs);
                    if (canonical.Length == 0)
                    {
                        // Fully-qualified syntax is already an exact identity and remains useful in small unit/CLI
                        // calls without an assembly graph. Unqualified names never fall back to short-name guessing.
                        canonical = CompactName(declaration.Type);
                        if (canonical.StartsWith("global::", StringComparison.Ordinal))
                            canonical = canonical.Substring("global::".Length);
                        if (canonical.IndexOf('.') < 0) return "";
                    }
                    canonicalBases.Add(canonical);
                }
                return canonicalBases.Count == 1 ? canonicalBases.Single() : "";
            }
            catch
            {
                return "";
            }
        }

        private static TypeSyntax? DeclaredBaseOf(ClassDeclarationSyntax cls)
        {
            return cls.BaseList?.Types.FirstOrDefault()?.Type;
        }

        private static string ResolveSemanticBase(TypeSyntax declaredBase, SyntaxTree declaredTree,
            IReadOnlyCollection<SyntaxTree> trees, string? assemblyPath, string[]? probeDirs)
        {
            if (string.IsNullOrWhiteSpace(assemblyPath) || !File.Exists(assemblyPath)) return "";
            try
            {
                var references = ReferencePaths(assemblyPath, probeDirs)
                    .Select(ReferenceFromSnapshot)
                    .Where(reference => reference != null)
                    .Cast<MetadataReference>()
                    .ToList();
                if (references.Count == 0) return "";

                var compilation = CSharpCompilation.Create(
                    "WfdCurrentSourceBase_" + Guid.NewGuid().ToString("N"),
                    trees,
                    references,
                    new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
                var symbol = compilation.GetSemanticModel(declaredTree, ignoreAccessibility: true)
                    .GetTypeInfo(declaredBase).Type as INamedTypeSymbol;
                return symbol == null || symbol.TypeKind == TypeKind.Error ? "" : RuntimeFullName(symbol);
            }
            catch
            {
                return "";
            }
        }

        private static IEnumerable<string> ReferencePaths(string assemblyPath, string[]? probeDirs)
        {
            var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            void Add(string? path)
            {
                if (string.IsNullOrWhiteSpace(path)) return;
                try
                {
                    string full = Path.GetFullPath(path);
                    if (File.Exists(full)) paths.Add(full);
                }
                catch { }
            }

            Add(typeof(object).Assembly.Location);
            Add(typeof(Enumerable).Assembly.Location);
            Add(typeof(System.ComponentModel.Component).Assembly.Location);
            Add(typeof(System.Drawing.Point).Assembly.Location);
            Add(typeof(System.Windows.Forms.Control).Assembly.Location);
            Add(assemblyPath);

            var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                string? assemblyDir = Path.GetDirectoryName(Path.GetFullPath(assemblyPath));
                if (!string.IsNullOrWhiteSpace(assemblyDir)) directories.Add(assemblyDir);
            }
            catch { }
            foreach (string dir in probeDirs ?? Array.Empty<string>())
            {
                try
                {
                    string full = Path.GetFullPath(dir);
                    if (Directory.Exists(full)) directories.Add(full);
                }
                catch { }
            }
            foreach (string dir in directories)
            {
                try
                {
                    foreach (string dll in Directory.EnumerateFiles(dir, "*.dll", SearchOption.TopDirectoryOnly))
                        Add(dll);
                }
                catch { }
            }
            return paths;
        }

        private static PortableExecutableReference? ReferenceFromSnapshot(string path)
        {
            try
            {
                var info = new FileInfo(path);
                lock (ReferenceLock)
                {
                    if (ReferenceCache.TryGetValue(path, out var cached)
                        && cached.Length == info.Length && cached.LastWriteTicks == info.LastWriteTimeUtc.Ticks)
                        return cached.Reference;
                }

                // CreateFromFile can keep a project/vendor DLL mapped in the default AppDomain and defeat ReleaseBinDir.
                // An immutable byte snapshot gives Roslyn the same metadata without pinning the user's build output.
                var reference = MetadataReference.CreateFromImage(ImmutableArray.Create(File.ReadAllBytes(path)));
                lock (ReferenceLock)
                {
                    ReferenceCache[path] = new ReferenceSnapshot
                    {
                        Length = info.Length,
                        LastWriteTicks = info.LastWriteTimeUtc.Ticks,
                        Reference = reference,
                    };
                }
                return reference;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Canonical identity matching <see cref="RuntimeTypeIdentity.Of(Type)"/> in the render domain.
        /// Unlike the old open-definition-only result, this retains concrete generic arguments, so
        /// <c>Base&lt;int&gt;</c> cannot be mistaken for either stale <c>Base&lt;string&gt;</c> or an unresolved open base.</summary>
        private static string RuntimeFullName(INamedTypeSymbol symbol)
        {
            string name = RuntimeDefinitionFullName(symbol.OriginalDefinition);
            var arguments = RuntimeTypeArguments(symbol).ToArray();
            return arguments.Length == 0
                ? name
                : name + "[" + string.Join(",", arguments.Select(RuntimeTypeArgumentName)) + "]";
        }

        private static string RuntimeDefinitionFullName(INamedTypeSymbol symbol)
        {
            var typeParts = new Stack<string>();
            for (INamedTypeSymbol? current = symbol; current != null; current = current.ContainingType)
                typeParts.Push(current.MetadataName);
            string types = string.Join("+", typeParts);
            string ns = symbol.ContainingNamespace?.IsGlobalNamespace == false
                ? symbol.ContainingNamespace.ToDisplayString()
                : "";
            return ns.Length == 0 ? types : ns + "." + types;
        }

        private static IEnumerable<ITypeSymbol> RuntimeTypeArguments(INamedTypeSymbol symbol)
        {
            if (symbol.ContainingType != null)
                foreach (ITypeSymbol argument in RuntimeTypeArguments(symbol.ContainingType)) yield return argument;
            foreach (ITypeSymbol argument in symbol.TypeArguments) yield return argument;
        }

        private static string RuntimeTypeArgumentName(ITypeSymbol symbol)
        {
            if (symbol is INamedTypeSymbol named) return RuntimeFullName(named);
            if (symbol is IArrayTypeSymbol array)
                return RuntimeTypeArgumentName(array.ElementType) + "[" + new string(',', array.Rank - 1) + "]";
            if (symbol is IPointerTypeSymbol pointer) return RuntimeTypeArgumentName(pointer.PointedAtType) + "*";
            if (symbol is ITypeParameterSymbol parameter)
            {
                int offset = 0;
                for (INamedTypeSymbol? outer = parameter.ContainingType?.ContainingType;
                     outer != null;
                     outer = outer.ContainingType)
                    offset += outer.Arity;
                return (parameter.TypeParameterKind == TypeParameterKind.Method ? "!!" : "!")
                    + (offset + parameter.Ordinal);
            }
            string display = symbol.ToDisplayString(SymbolDisplayFormat.FullyQualifiedFormat);
            return display.StartsWith("global::", StringComparison.Ordinal)
                ? display.Substring("global::".Length)
                : display;
        }

        private static string CompactName(TypeSyntax type)
        {
            return string.Concat(type.DescendantTokens(descendIntoTrivia: false).Select(token => token.Text));
        }

        private static string CodeBehindPath(string designerFilePath)
        {
            const string suffix = ".Designer.cs";
            if (string.IsNullOrWhiteSpace(designerFilePath)
                || !designerFilePath.EndsWith(suffix, System.StringComparison.OrdinalIgnoreCase))
                return "";
            return designerFilePath.Substring(0, designerFilePath.Length - suffix.Length) + ".cs";
        }
    }
}
