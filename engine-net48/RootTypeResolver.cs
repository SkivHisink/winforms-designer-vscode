using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Derives the fully-qualified control type name from a .Designer.cs (or its main .cs) so the worker can
    /// find the compiled type. Runs in the HOST domain (keeps Roslyn out of the render child domain). Handles
    /// block + file-scoped namespaces and nested types.
    /// </summary>
    public static class RootTypeResolver
    {
        public static string Resolve(string designerFilePath)
        {
            string code = File.ReadAllText(designerFilePath);
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            var cls = root.DescendantNodes().OfType<ClassDeclarationSyntax>().FirstOrDefault();
            if (cls == null) return "";

            string name = cls.Identifier.Text;
            for (SyntaxNode? p = cls.Parent; p != null; p = p.Parent)
            {
                switch (p)
                {
                    case BaseNamespaceDeclarationSyntax ns: // block + file-scoped
                        name = ns.Name.ToString() + "." + name;
                        break;
                    case ClassDeclarationSyntax outer: // nested type
                        name = outer.Identifier.Text + "+" + name;
                        break;
                }
            }
            return name;
        }
    }
}
