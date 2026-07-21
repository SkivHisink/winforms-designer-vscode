using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// THE rule that decides which class in a <c>.Designer.cs</c> is the form, and which of its methods is the
    /// <c>InitializeComponent</c> to interpret/rewrite. Every consumer resolves through here — both engines (this
    /// file is COMPILE-LINKED into the net48 host, not copied) and every byte-surgical editor.
    ///
    /// Why one file rather than "careful" duplicates: the renderer, the save splicer, the statement-diff gate and a
    /// dozen editors each used to answer this question themselves. They happened to agree — all took the first
    /// DESCENDANT class declaring a method named InitializeComponent — and the agreement, not any local rule, was
    /// the safety property: the instant two of them disagree, a "safe" save regenerates one class's body into
    /// another's, and the file no longer compiles. Two attempts at a smarter local rule proved it (a file-name
    /// tiebreak: renderer chose Foo, splicer rewrote Helper; a top-level-only filter: renderer chose the form,
    /// splicer rewrote a NESTED helper's InitializeComponent) — both caught in review, neither by a test. Sharing
    /// the resolver makes divergence unrepresentable instead of merely unlikely, which is also what finally made it
    /// safe to tighten the rule at all (below).
    ///
    /// The rule is UNIQUENESS, not a preference order: exactly one candidate class, or nobody renders. Ambiguity
    /// (a second form, or a helper — possibly nested — declaring InitializeComponent beside it) refuses the whole
    /// file. Refusing is the honest answer; picking one is how the wrong class gets rewritten.
    /// </summary>
    public static class FormClassResolver
    {
        /// <summary>
        /// THE designer class in this file, or null when the file declares none — or more than one (→ every caller
        /// must fail closed, never fall back to "some class"). Callers that need the method too should prefer
        /// <see cref="InitMethod"/>, so the class and the method can never be resolved by different rules.
        /// </summary>
        public static ClassDeclarationSyntax? FormClass(SyntaxNode root)
        {
            // NOTE: deliberately no top-level filter — a nested declarer is not quietly skipped but makes the file
            // AMBIGUOUS, because a skip here would be a rule the other consumers don't share.
            var candidates = root.DescendantNodes().OfType<ClassDeclarationSyntax>().Where(DeclaresInit).ToList();

            // Two partials of ONE class cannot both declare InitializeComponent (duplicate method), so a single
            // candidate stays unambiguous even for a form split across partials — PartialsOf() collects its
            // siblings for the field scan.
            return candidates.Count == 1 ? candidates[0] : null;
        }

        /// <summary>The form's <c>InitializeComponent</c> — the authoritative (class, method) identity, resolved in
        /// one step. Null when the file has no single designer class.</summary>
        public static MethodDeclarationSyntax? InitMethod(SyntaxNode root) => InitMethodOf(FormClass(root));

        /// <summary>
        /// The <c>InitializeComponent</c> of a known class: the PARAMETERLESS one.
        ///
        /// The overload filter and <see cref="DeclaresInit"/> are the same predicate on purpose — "is this the form"
        /// and "which method do I rewrite" must be one decision. Matching by name alone let a class declaring an
        /// <c>InitializeComponent(int)</c> overload ahead of the real one render empty (the interpreter took the
        /// first by name and found no statements) with no banner; a class declaring ONLY an overload is now not a
        /// designer class at all, and the file fails closed instead. Tightening this was only safe once every
        /// consumer resolved through this file — the same tightening applied to one selector alone is exactly the
        /// divergence described above, so it was correctly left alone until then.
        /// </summary>
        public static MethodDeclarationSyntax? InitMethodOf(ClassDeclarationSyntax? cls) =>
            cls?.Members.OfType<MethodDeclarationSyntax>()
                .FirstOrDefault(m => m.Identifier.Text == "InitializeComponent"
                                     && m.ParameterList.Parameters.Count == 0);

        /// <summary>Declares the form's <c>InitializeComponent</c>. Candidacy is defined BY the method lookup, so the
        /// two can't drift apart.</summary>
        public static bool DeclaresInit(ClassDeclarationSyntax c) => InitMethodOf(c) != null;

        /// <summary>
        /// Every top-level declaration of <paramref name="form"/> in its file — itself plus the other partials of the
        /// same NAMESPACE-QUALIFIED name (an unrelated <c>namespace Other { partial class SameName }</c> is excluded).
        /// A form may legitimately split its component fields into one partial and <c>InitializeComponent</c> into
        /// another; anything that reads the form's fields must look across all of them or it will decide a perfectly
        /// valid file is unrepresentable.
        /// </summary>
        public static IReadOnlyList<ClassDeclarationSyntax> PartialsOf(ClassDeclarationSyntax form)
        {
            // Matched on the FULL identity — namespace + enclosing type chain + generic arity — so no top-level filter
            // is needed to keep an unrelated nested `Other.Inner` out: its identity simply differs. The filter used to
            // be the guard, with a fallback to "just the form" for a nested one; that silently dropped the sibling
            // NESTED partials of a legitimately split nested form, whose fields then read as unrepresentable.
            string fq = QualifiedName(form);
            return form.SyntaxTree.GetRoot().DescendantNodes().OfType<ClassDeclarationSyntax>()
                .Where(c => QualifiedName(c) == fq).ToList();
        }

        /// <summary>The component field names of the form, across ALL its partials in the file.</summary>
        public static HashSet<string> FieldNamesOf(ClassDeclarationSyntax form)
        {
            var set = new HashSet<string>(StringComparer.Ordinal);
            foreach (var part in PartialsOf(form))
                foreach (var f in part.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var v in f.Declaration.Variables)
                        set.Add(v.Identifier.Text);
            return set;
        }

        /// <summary>
        /// A class declaration's full identity: namespace + enclosing type chain + generic arity —
        /// <c>"Product.Ui.Outer+NestedForm"</c>, <c>"N.Dup`2"</c>. Two declarations are partials of ONE class exactly
        /// when these match, so this is what identity comparisons use rather than the simple name.
        ///
        /// Every component of it earns its place: without the namespace an unrelated
        /// <c>namespace Other { partial class SameName }</c> is treated as a partial of the form; without the outer
        /// chain a nested <c>Outer.Form1</c> collides with a top-level <c>Form1</c>; without arity <c>Dup&lt;T&gt;</c>
        /// and <c>Dup&lt;T,U&gt;</c> collide.
        /// </summary>
        public static string QualifiedName(ClassDeclarationSyntax c)
        {
            string name = NameOf(c.Identifier, c.TypeParameterList);
            for (SyntaxNode? p = c.Parent; p != null; p = p.Parent)
            {
                switch (p)
                {
                    case TypeDeclarationSyntax outer:            // nested type: Outer+Inner (reflection's separator)
                        name = NameOf(outer.Identifier, outer.TypeParameterList) + "+" + name;
                        break;
                    case BaseNamespaceDeclarationSyntax nd:      // block + file-scoped
                        name = NamespaceOf(nd.Name) + "." + name;
                        break;
                }
            }
            return name;
        }

        // VALUE text, not the raw spelling: `namespace @Ui { partial class @Form1 }` is a legal C# escape whose
        // metadata name is plainly "Ui.Form1". Taking Identifier.Text kept the '@' (and a \uXXXX escape), producing an
        // identity that matches no compiled type — the net48 host then reported an up-to-date assembly as a stale
        // build. ValueText is the decoded identifier, which is what the CLR sees.
        private static string NameOf(SyntaxToken id, TypeParameterListSyntax? typeParams)
        {
            int arity = typeParams?.Parameters.Count ?? 0;
            return arity > 0 ? id.ValueText + "`" + arity : id.ValueText;
        }

        private static string NamespaceOf(NameSyntax name) => name switch
        {
            QualifiedNameSyntax q => NamespaceOf(q.Left) + "." + NamespaceOf(q.Right),
            SimpleNameSyntax s => s.Identifier.ValueText,
            _ => name.ToString(),
        };
    }
}
