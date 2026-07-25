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
                var cls = node.AncestorsAndSelf().OfType<ClassDeclarationSyntax>().FirstOrDefault();
                return cls != null && FormClassResolver.QualifiedName(cls) == _formIdentity;
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
