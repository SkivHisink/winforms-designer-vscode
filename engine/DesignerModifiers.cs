using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// The design-time "Modifiers" / "GenerateMember" pseudo-properties (VS parity), handled purely as SOURCE
    /// artifacts — the modifier is the access keyword of a component's field declaration, and GenerateMember is
    /// simply "does a field exist". Reading and writing them never touches InitializeComponent, so a Modifiers edit
    /// is a byte-local splice of ONE field declaration's access keyword and is safe on EVERY form (even ones the
    /// whole-file serializer refuses: binary-resx, localizable, unresolved-vendor). GenerateMember's toggle
    /// (field ↔ local) is a structural change that is NOT round-trip-safe, so it is surfaced read-only.
    /// </summary>
    public static class DesignerModifiers
    {
        // VS display name ↔ C# access-modifier keyword. Order matches the VS "Modifiers" dropdown.
        private static readonly (string Display, string Keyword)[] Kinds =
        {
            ("Public", "public"),
            ("Private", "private"),
            ("Protected", "protected"),
            ("Internal", "internal"),
            ("Protected Internal", "protected internal"),
            ("Private Protected", "private protected"),
        };

        /// <summary>The dropdown options for the grid (VS display names), e.g. Public / Private / Protected.</summary>
        public static List<string> DisplayNames => Kinds.Select(k => k.Display).ToList();

        /// <summary>Current modifier of one field declaration.</summary>
        public readonly struct FieldMod
        {
            /// <summary>VS display name of the current access modifier (e.g. "Private").</summary>
            public string Display { get; init; }
            /// <summary>False when the modifier cannot be safely edited (a multi-declarator field, or an
            /// unrecognized access combination) → the grid shows it read-only.</summary>
            public bool Editable { get; init; }
        }

        /// <summary>Result of a byte-local Modifiers splice (shape mirrors the property-edit preview).</summary>
        public sealed class ModifierResult
        {
            public bool Safe { get; init; }
            /// <summary>The whole spliced file text (only the field's access keyword changed), or null when refused.</summary>
            public string? Text { get; init; }
            public string Reason { get; init; } = "";
        }

        /// <summary>Parse each single-declarator field declaration → (field name → current modifier). A component
        /// whose name is absent has no field (GenerateMember=false). Multi-declarator fields are included but marked
        /// non-editable (changing the shared modifier would affect the siblings).</summary>
        public static Dictionary<string, FieldMod> ParseFieldModifiers(string sourceText)
        {
            var map = new Dictionary<string, FieldMod>(StringComparer.Ordinal);
            SyntaxNode root;
            try { root = CSharpSyntaxTree.ParseText(sourceText).GetRoot(); }
            catch { return map; }
            // ONLY the designer form class's own field members (across its same-name partials in this file) — never a
            // nested type's fields nor an unrelated helper's (a nested/earlier `class Helper { string okButton; }`
            // must not shadow the real component field).
            foreach (var cls in DesignerFormClasses(root))
            {
                foreach (var f in cls.Members.OfType<FieldDeclarationSyntax>())
                {
                    var vars = f.Declaration.Variables;
                    bool single = vars.Count == 1;
                    string display = DisplayOf(f.Modifiers);
                    bool recognized = display.Length > 0;
                    foreach (var v in vars)
                    {
                        // last writer wins is irrelevant — designer field names are unique
                        map[v.Identifier.Text] = new FieldMod { Display = recognized ? display : "Private", Editable = single && recognized };
                    }
                }
            }
            return map;
        }

        /// <summary>
        /// THE form class to render/edit in this file, or null if the file declares none — or more than one (→ the
        /// caller must fail closed, never fall back to "some class"). Thin alias for
        /// <see cref="FormClassResolver.FormClass"/>, which every consumer — both engines included — now shares;
        /// see that file for why the resolver is one physical file rather than agreeing duplicates.
        /// <paramref name="designerFilePath"/> is kept for diagnostics only.
        /// </summary>
        public static ClassDeclarationSyntax? DesignerFormClass(SyntaxNode root, string? designerFilePath = null)
        {
            _ = designerFilePath;
            return FormClassResolver.FormClass(root);
        }

        /// <summary>Every top-level declaration of the form in its file (its partials) — see
        /// <see cref="FormClassResolver.PartialsOf"/>.</summary>
        public static IReadOnlyList<ClassDeclarationSyntax> PartialsOf(ClassDeclarationSyntax form) =>
            FormClassResolver.PartialsOf(form);

        /// <summary>"…/Foo.Designer.cs" → "Foo"; "…/Foo.cs" → "Foo". Null when there is no usable file name.</summary>
        internal static string? FormNameFromPath(string? designerFilePath)
        {
            if (string.IsNullOrEmpty(designerFilePath)) return null;
            string name = Path.GetFileName(designerFilePath);
            if (name.Length == 0) return null;
            int dot = name.IndexOf('.');                       // strip ".Designer.cs" / ".cs" (a form name has no dot)
            return dot > 0 ? name.Substring(0, dot) : name;
        }

        /// <summary>The designer form's class declarations in this file: the form plus every OTHER top-level partial of
        /// the same namespace-qualified name (a form legitimately split across partials in one file). Its fields are the
        /// component fields; a nested helper type's fields are deliberately out of scope. Empty when the file declares
        /// no single designer class (→ fail closed).</summary>
        internal static IReadOnlyList<ClassDeclarationSyntax> DesignerFormClasses(SyntaxNode root, string? designerFilePath = null)
        {
            var form = DesignerFormClass(root, designerFilePath);
            return form == null ? Array.Empty<ClassDeclarationSyntax>() : FormClassResolver.PartialsOf(form);
        }

        /// <summary>Byte-local: replace the access-modifier keyword(s) of the field declaring <paramref name="fieldName"/>
        /// with <paramref name="newModifier"/> (a VS display name or a C# keyword). Only the field's access tokens
        /// change; every other byte of the file is preserved.</summary>
        public static ModifierResult SetModifier(string sourceText, string fieldName, string newModifier)
        {
            string? keyword = ToKeyword(newModifier);
            if (keyword == null) return new ModifierResult { Reason = "unknown modifier: " + newModifier };

            SyntaxNode root;
            try { root = CSharpSyntaxTree.ParseText(sourceText).GetRoot(); }
            catch (Exception ex) { return new ModifierResult { Reason = "parse error: " + ex.Message }; }

            var classes = DesignerFormClasses(root);
            if (classes.Count == 0) return new ModifierResult { Reason = "no designer class (InitializeComponent) in source" };

            FieldDeclarationSyntax? field = null;
            // ONLY the designer form's own field members (across its same-name partials) — never a nested type's fields
            // nor an unrelated helper's.
            foreach (var f in classes.SelectMany(c => c.Members.OfType<FieldDeclarationSyntax>()))
            {
                var vars = f.Declaration.Variables;
                if (!vars.Any(v => v.Identifier.Text == fieldName)) continue;
                if (vars.Count != 1)
                    return new ModifierResult { Reason = "field '" + fieldName + "' shares a multi-declarator declaration; refusing (would change its siblings)" };
                field = f;
                break;
            }
            if (field == null) return new ModifierResult { Reason = "no field declaration for '" + fieldName + "'" };

            var access = field.Modifiers
                .Where(m => AccessKinds.Contains(m.Kind()))
                .ToList();
            if (access.Count == 0)
                return new ModifierResult { Reason = "field '" + fieldName + "' has no explicit access modifier; refusing" };

            int start = access[0].Span.Start;         // after the leading indent (trivia is outside .Span)
            int end = access[access.Count - 1].Span.End; // before the trailing space + type (also net48-compatible)
            string current = sourceText.Substring(start, end - start);
            // ONLY the [start,end) span is replaced, so check THAT exact text (not token trivia, which can reach a
            // comment AFTER the last access token and false-refuse). The span must be ONLY access
            // keywords + whitespace; a comment, a preprocessor directive, or a non-access modifier (static/readonly)
            // BETWEEN the access tokens would be silently deleted → refuse. Strip the access keywords: any
            // non-whitespace residue means interior content that would be lost. A single-keyword field → empty residue.
            string residue = current;
            foreach (var (_, kw) in Kinds) residue = residue.Replace(kw, " ");
            if (residue.Any(ch => !char.IsWhiteSpace(ch)))
                return new ModifierResult { Reason = "field '" + fieldName + "' has a comment, directive, or extra modifier between its access keywords; refusing (would delete it)" };
            if (current == keyword)
                return new ModifierResult { Safe = true, Text = sourceText, Reason = "unchanged" };

            string spliced = sourceText.Substring(0, start) + keyword + sourceText.Substring(end);

            // sanity: the result must still parse and the change must be confined to the field's line
            if (CSharpSyntaxTree.ParseText(spliced).GetRoot().ContainsDiagnostics
                && CSharpSyntaxTree.ParseText(spliced).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error))
                return new ModifierResult { Reason = "spliced modifier would not parse" };

            return new ModifierResult { Safe = true, Text = spliced, Reason = "Modifier" };
        }

        private static readonly HashSet<SyntaxKind> AccessKinds = new()
        {
            SyntaxKind.PublicKeyword, SyntaxKind.PrivateKeyword, SyntaxKind.ProtectedKeyword, SyntaxKind.InternalKeyword,
        };

        /// <summary>VS display name of the access modifiers present, or "" if none/unrecognized.</summary>
        private static string DisplayOf(SyntaxTokenList mods)
        {
            bool pub = mods.Any(m => m.IsKind(SyntaxKind.PublicKeyword));
            bool priv = mods.Any(m => m.IsKind(SyntaxKind.PrivateKeyword));
            bool prot = mods.Any(m => m.IsKind(SyntaxKind.ProtectedKeyword));
            bool intl = mods.Any(m => m.IsKind(SyntaxKind.InternalKeyword));
            if (pub) return "Public";
            if (priv && prot) return "Private Protected";
            if (prot && intl) return "Protected Internal";
            if (priv) return "Private";
            if (prot) return "Protected";
            if (intl) return "Internal";
            return "";
        }

        /// <summary>Map a VS display name or a raw C# keyword to the canonical keyword form, or null if unknown.</summary>
        private static string? ToKeyword(string modifier)
        {
            string m = modifier.Trim();
            foreach (var (display, keyword) in Kinds)
            {
                if (string.Equals(m, display, StringComparison.OrdinalIgnoreCase)) return keyword;
                if (string.Equals(m, keyword, StringComparison.OrdinalIgnoreCase)) return keyword;
            }
            return null;
        }
    }
}
