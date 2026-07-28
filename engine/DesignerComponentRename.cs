using System;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Source-only component-field rename used by the component tray. It renames exactly the field declarator,
    /// <c>this.oldName</c> references in every partial declaration of the form, and the canonical
    /// <c>this.newName.Name = "oldName"</c> value when present. Locals, unrelated string literals and sibling
    /// classes are never touched.
    /// </summary>
    public static class DesignerComponentRename
    {
        public static ControlAddResult Rename(string sourceText, string oldId, string newId)
        {
            if (!IsIdentifier(oldId))
                return Failed("invalid component id: " + oldId);
            if (!IsIdentifier(newId))
                return Failed("invalid new component id: " + newId);
            if (oldId == newId)
                return new ControlAddResult { Safe = true, Name = oldId, NewText = sourceText };

            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var form = FormClassResolver.FormClass(root);
            if (form == null)
                return Failed("InitializeComponent not found");
            var fields = FormClassResolver.FieldNamesOf(form);
            if (!fields.Contains(oldId))
                return Failed("unknown component id: " + oldId);
            if (fields.Contains(newId))
                return Failed("a field named " + newId + " already exists");
            if (HasUnqualifiedReference(form, oldId))
                return Failed("cannot rename " + oldId + ": the designer file references it without a this. qualifier");

            string identity = FormClassResolver.QualifiedName(form);
            var renamed = new RenameRewriter(identity, oldId, newId).Visit(root);
            if (renamed == null)
                return Failed("component rename failed");
            string newText = renamed.ToFullString();
            bool parseOk = !CSharpSyntaxTree.ParseText(newText).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = parseOk && OnlyComponentRenamed(sourceText, newText, oldId, newId);
            return minimal
                ? new ControlAddResult { Safe = true, Name = newId, NewText = newText }
                : Failed(parseOk ? "rename changed more than the selected component field" : "renamed text has syntax errors");
        }

        /// <summary>True when the form refers to <paramref name="id"/> anywhere other than as <c>this.id</c> — the
        /// only shape <see cref="RenameRewriter"/> rewrites. A designer file whose <c>this.</c> qualifiers were
        /// stripped (exactly what <c>dotnet format</c> / IDE0003 "remove this qualification" does, and it does not
        /// skip designer files) still renders and still lists the component in the tray, so the rename looks
        /// available; carrying it out would move the declarator and leave every bare <c>id</c> use dangling. The
        /// minimality gate cannot catch that, because it proves reversibility with the SAME rewriter and therefore
        /// shares the blind spot exactly. So refuse up front instead of shipping a file that will not compile.</summary>
        private static bool HasUnqualifiedReference(ClassDeclarationSyntax form, string id)
        {
            string identity = FormClassResolver.QualifiedName(form);
            return FormClassResolver.PartialsOf(form)
                .SelectMany(part => part.DescendantNodes().OfType<IdentifierNameSyntax>())
                .Where(name => name.Identifier.ValueText == id)
                // Only references that belong to the FORM itself. A nested helper class has its own scope — its
                // members can't denote the form's instance field, and the rewriter (InForm) skips them too, so
                // counting them here would refuse a perfectly good rename.
                .Where(name => name.Ancestors().OfType<ClassDeclarationSyntax>().FirstOrDefault() is { } cls
                    && FormClassResolver.QualifiedName(cls) == identity)
                .Where(name => name.Parent is not MemberAccessExpressionSyntax member
                    || member.Expression is not ThisExpressionSyntax
                    || member.Name != name)
                .Any(name => !ShadowedByLocal(name, id));
        }

        /// <summary>True when a parameter or local of the same name is in scope AT this bare identifier, so the
        /// identifier is that local rather than the field and the rewriter is right to leave it alone. Scope is walked
        /// the way C# defines it — outwards through the ENCLOSING scopes only. A member-wide search would be wrong in
        /// the direction that matters: a local declared in a sibling or nested block does not shadow anything here, so
        /// treating it as a shadow would wave through exactly the half-rename this guard exists to stop.</summary>
        private static bool ShadowedByLocal(SyntaxNode reference, string id)
        {
            for (var scope = reference.Parent; scope != null; scope = scope.Parent)
            {
                if (DeclaresInScope(scope, reference, id))
                    return true;
                if (scope is BaseMethodDeclarationSyntax method)
                    return method.ParameterList.Parameters.Any(p => p.Identifier.ValueText == id);
                if (scope is AccessorDeclarationSyntax or MemberDeclarationSyntax)
                    return false;
            }
            return false;
        }

        /// <summary>Locals introduced BY this scope node itself (not by anything nested inside it).</summary>
        private static bool DeclaresInScope(SyntaxNode scope, SyntaxNode reference, string id)
        {
            switch (scope)
            {
                // The iteration variable is scoped to the EMBEDDED STATEMENT only — a reference in the collection
                // expression (`foreach (var x in Pick(x))`) is still the outer name, i.e. the field.
                case ForEachStatementSyntax f when f.Identifier.ValueText == id
                    && f.Statement.Span.Contains(reference.Span):
                    return true;
                // The catch VARIABLE is declared on the clause, while the reference lives in the clause's block — so
                // the declaration is a child of an enclosing scope, never an ancestor of the reference.
                case CatchClauseSyntax cc when cc.Declaration?.Identifier.ValueText == id:
                    return true;
                case SimpleLambdaExpressionSyntax l when l.Parameter.Identifier.ValueText == id:
                    return true;
                case ParenthesizedLambdaExpressionSyntax pl when pl.ParameterList.Parameters.Any(p => p.Identifier.ValueText == id):
                    return true;
                // A `for` / `using (…)` variable lives ONLY for that statement. It is reached here as an ANCESTOR of
                // the reference, which is exactly the case where it really is in scope; treating it as a declaration
                // of the enclosing block instead would suppress the refusal for a bare reference AFTER the loop,
                // where the name is the field again — the half-rename this guard exists to stop.
                case ForStatementSyntax fs when fs.Declaration?.Variables.Any(v => v.Identifier.ValueText == id) == true:
                    return true;
                case UsingStatementSyntax us when us.Declaration?.Variables.Any(v => v.Identifier.ValueText == id) == true:
                    return true;
            }
            // Block-scoped declarations belonging directly to this scope (`var x = …;`, `using var x = …;`).
            foreach (var child in scope.ChildNodes())
            {
                if (child is LocalDeclarationStatementSyntax local
                    && local.Declaration.Variables.Any(v => v.Identifier.ValueText == id))
                    return true;
                if (child is SingleVariableDesignationSyntax d && d.Identifier.ValueText == id)
                    return true;
            }
            return false;
        }

        public static bool OnlyComponentRenamed(string original, string edited, string oldId, string newId)
        {
            if (!IsIdentifier(oldId) || !IsIdentifier(newId))
                return false;
            var editedRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            var editedForm = FormClassResolver.FormClass(editedRoot);
            if (editedForm == null)
                return false;
            var editedFields = FormClassResolver.FieldNamesOf(editedForm);
            if (editedFields.Contains(oldId) || !editedFields.Contains(newId))
                return false;

            string identity = FormClassResolver.QualifiedName(editedForm);
            var reversed = new RenameRewriter(identity, newId, oldId).Visit(editedRoot);
            return reversed != null
                && string.Equals(original, reversed.ToFullString(), StringComparison.Ordinal);
        }

        private sealed class RenameRewriter : CSharpSyntaxRewriter
        {
            private readonly string _formIdentity;
            private readonly string _oldId;
            private readonly string _newId;

            public RenameRewriter(string formIdentity, string oldId, string newId)
            {
                _formIdentity = formIdentity;
                _oldId = oldId;
                _newId = newId;
            }

            public override SyntaxNode? VisitVariableDeclarator(VariableDeclaratorSyntax node)
            {
                var visited = (VariableDeclaratorSyntax)base.VisitVariableDeclarator(node)!;
                if (!InForm(node)
                    || node.Parent?.Parent is not FieldDeclarationSyntax
                    || node.Identifier.ValueText != _oldId)
                    return visited;
                return visited.WithIdentifier(RenamedToken(visited.Identifier));
            }

            public override SyntaxNode? VisitMemberAccessExpression(MemberAccessExpressionSyntax node)
            {
                var visited = (MemberAccessExpressionSyntax)base.VisitMemberAccessExpression(node)!;
                if (!InForm(node)
                    || node.Expression is not ThisExpressionSyntax
                    || node.Name.Identifier.ValueText != _oldId)
                    return visited;
                return visited.WithName(visited.Name.WithIdentifier(RenamedToken(visited.Name.Identifier)));
            }

            public override SyntaxNode? VisitAssignmentExpression(AssignmentExpressionSyntax node)
            {
                var visited = (AssignmentExpressionSyntax)base.VisitAssignmentExpression(node)!;
                if (!InForm(node)
                    || node.Right is not LiteralExpressionSyntax literal
                    || !literal.IsKind(SyntaxKind.StringLiteralExpression)
                    || literal.Token.ValueText != _oldId)
                    return visited;

                // The member-access child has already been rewritten old->new. Only update the canonical Name
                // assignment belonging to that same component; an unrelated Text/Tag string stays untouched.
                if (Flatten(visited.Left) is var chain
                    && chain.Length == 2 && chain[0] == _newId && chain[1] == "Name")
                {
                    return visited.WithRight(SyntaxFactory.LiteralExpression(
                        SyntaxKind.StringLiteralExpression,
                        SyntaxFactory.Literal(_newId)).WithTriviaFrom(visited.Right));
                }
                return visited;
            }

            private bool InForm(SyntaxNode node)
            {
                // The NEAREST enclosing type must BE the form. Looking only for the nearest enclosing *class* let a
                // nested struct or record fall through to the form's own identity, so an unrelated `toolTip1` member
                // inside one was renamed too — and the reverse rewriter repeated the overreach, which made the
                // unrelated mutation look reversible to the minimality gate.
                var type = node.AncestorsAndSelf().OfType<TypeDeclarationSyntax>().FirstOrDefault();
                return type is ClassDeclarationSyntax cls && FormClassResolver.QualifiedName(cls) == _formIdentity;
            }

            private SyntaxToken RenamedToken(SyntaxToken token) =>
                SyntaxFactory.Identifier(token.LeadingTrivia, SyntaxKind.IdentifierToken, _newId, _newId, token.TrailingTrivia);
        }

        private static string[] Flatten(ExpressionSyntax expression)
        {
            if (expression is MemberAccessExpressionSyntax member)
            {
                var prefix = Flatten(member.Expression);
                if (prefix.Length == 1 && prefix[0] == "this")
                    return new[] { member.Name.Identifier.ValueText };
                return prefix.Concat(new[] { member.Name.Identifier.ValueText }).ToArray();
            }
            if (expression is ThisExpressionSyntax) return new[] { "this" };
            if (expression is IdentifierNameSyntax identifier) return new[] { identifier.Identifier.ValueText };
            return Array.Empty<string>();
        }

        private static bool IsIdentifier(string value) =>
            !string.IsNullOrWhiteSpace(value) && SyntaxFacts.IsValidIdentifier(value);

        private static ControlAddResult Failed(string reason) =>
            new() { Safe = false, Reason = reason };
    }
}
