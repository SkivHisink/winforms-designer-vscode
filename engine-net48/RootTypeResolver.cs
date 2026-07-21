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
    }
}
