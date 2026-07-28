using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Pure-source writer for the common WinForms extender-provider call shape
    /// <c>this.provider.SetProperty(this.target, value)</c>. The provider/property/type combinations are closed,
    /// values are emitted as literals or allowlisted enum members, and the minimal-diff gate treats every other
    /// InitializeComponent statement as immutable.
    /// </summary>
    public static class DesignerExtenderEditor
    {
        private sealed record Spec(string ProviderSuffix, string Property, string TypeName, string? EnumType = null);

        private static readonly Spec[] Specs =
        {
            new("ToolTip", "ToolTip", "System.String"),
            new("ErrorProvider", "Error", "System.String"),
            new("ErrorProvider", "IconAlignment", "System.Windows.Forms.ErrorIconAlignment", "System.Windows.Forms.ErrorIconAlignment"),
            new("ErrorProvider", "IconPadding", "System.Int32"),
            new("HelpProvider", "HelpString", "System.String"),
            new("HelpProvider", "HelpKeyword", "System.String"),
            new("HelpProvider", "HelpNavigator", "System.Windows.Forms.HelpNavigator", "System.Windows.Forms.HelpNavigator"),
            new("HelpProvider", "ShowHelp", "System.Boolean"),
        };

        public static EditResult SetValue(string sourceText, string providerId, string targetId,
            string propertyName, string propertyType, string rawValue)
        {
            if (!IsIdentifier(providerId) || !IsIdentifier(targetId) || !IsIdentifier(propertyName))
                return Failed("invalid extender target");
            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FormClassResolver.FormClass(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null)
                return Failed("InitializeComponent not found");

            var fields = FieldTypes(cls);
            if (!fields.TryGetValue(providerId, out var providerType))
                return Failed("unknown extender provider: " + providerId);
            if (!fields.ContainsKey(targetId))
                return Failed("unknown extender target: " + targetId);
            var spec = Specs.FirstOrDefault(x => x.Property == propertyName
                && x.TypeName == propertyType
                && providerType.Replace("global::", "", StringComparison.Ordinal)
                    .EndsWith(x.ProviderSuffix, StringComparison.Ordinal));
            if (spec == null)
                return Failed("unsupported extender property: " + propertyName);
            if (!TryExpression(spec, rawValue ?? "", out var expression))
                return Failed("invalid " + propertyName + " value: " + rawValue);

            var targets = init.Body.Statements.Where(st =>
                IsTargetCall(st, providerId, targetId, propertyName, out _)).ToList();
            if (targets.Count > 1)
                return Failed("duplicate extender assignments for " + propertyName);
            if (targets.Any(HasMeaningfulTrivia))
                return Failed("the extender assignment contains comments or directives");

            string nl = sourceText.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
            string statementCode = "this." + providerId + ".Set" + propertyName
                + "(this." + targetId + ", " + expression + ");";
            if (targets.Count == 1)
            {
                var old = targets[0];
                // The call SHAPE matching is not enough to overwrite it: IsTargetCall only pins the provider, method
                // name, target and arity, so a hand-written value expression (a helper call, a field, a concatenation)
                // matched too and was replaced by a literal — silent source loss. Only a value this editor could have
                // emitted itself may be regenerated.
                if (!IsTargetCall(old, providerId, targetId, propertyName, out var existing)
                    || existing == null || existing.Value.Count != 2
                    || !IsRepresentableValue(spec, existing.Value[1].Expression))
                    return Failed("the existing " + propertyName + " value is a custom expression — edit it in code");
                string indent = LineIndent(old);
                var replacement = SyntaxFactory.ParseStatement(statementCode)
                    .WithLeadingTrivia(SyntaxFactory.Whitespace(indent))
                    .WithTrailingTrivia(old.GetTrailingTrivia());
                var newText = root.ReplaceNode(old, replacement).ToFullString();
                return new EditResult { NewText = newText, Mode = EditMode.Replace };
            }

            var statements = init.Body.Statements.ToList();
            int anchor = statements.FindLastIndex(st => MentionsOwnerAssignment(st, targetId));
            if (anchor < 0)
                return Failed("no assignment references " + targetId + " to anchor the extender value");
            string bodyIndent = LineIndent(statements[anchor]);
            var inserted = SyntaxFactory.ParseStatement(statementCode)
                .WithLeadingTrivia(SyntaxFactory.Whitespace(bodyIndent))
                .WithTrailingTrivia(SyntaxFactory.EndOfLine(nl));
            statements.Insert(anchor + 1, inserted);
            var newInit = init.WithBody(init.Body.WithStatements(SyntaxFactory.List(statements)));
            return new EditResult { NewText = root.ReplaceNode(init, newInit).ToFullString(), Mode = EditMode.Insert };
        }

        public static bool OnlyExtenderChanged(string original, string edited, string providerId,
            string targetId, string propertyName, EditMode mode)
        {
            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            if (oRoot.ContainsDiagnostics || eRoot.ContainsDiagnostics) return false;
            var oInit = FormClassResolver.InitMethod(oRoot);
            var eInit = FormClassResolver.InitMethod(eRoot);
            if (oInit?.Body == null || eInit?.Body == null) return false;
            var oTargets = oInit.Body.Statements.Where(st => IsTargetCall(st, providerId, targetId, propertyName, out _)).ToList();
            var eTargets = eInit.Body.Statements.Where(st => IsTargetCall(st, providerId, targetId, propertyName, out _)).ToList();
            int expected = mode == EditMode.Insert ? oTargets.Count + 1 : oTargets.Count;
            if (eTargets.Count != expected || eTargets.Count != 1 || eTargets.Any(HasMeaningfulTrivia)) return false;
            if (!IsTargetCall(eTargets[0], providerId, targetId, propertyName, out var args) || args == null || args.Value.Count != 2)
                return false;
            // Defence in depth for the same hole SetValue closes: if the ORIGINAL carried a custom value expression,
            // this scrub-and-compare gate would happily accept an edit that erased it. Property names are unique
            // across the spec table, so the property alone identifies how its value is written.
            var gateSpec = Specs.FirstOrDefault(x => x.Property == propertyName);
            if (gateSpec == null) return false;
            if (oTargets.Count == 1
                && (!IsTargetCall(oTargets[0], providerId, targetId, propertyName, out var oldArgs)
                    || oldArgs == null || oldArgs.Value.Count != 2
                    || !IsRepresentableValue(gateSpec, oldArgs.Value[1].Expression)))
                return false;

            var oNon = oInit.Body.Statements.Where(st => !IsTargetCall(st, providerId, targetId, propertyName, out _))
                .Select(st => st.ToFullString()).ToList();
            var eNon = eInit.Body.Statements.Where(st => !IsTargetCall(st, providerId, targetId, propertyName, out _))
                .Select(st => st.ToFullString()).ToList();
            if (!oNon.SequenceEqual(eNon, StringComparer.Ordinal)) return false;
            var oScrub = oRoot.ReplaceNode(oInit, oInit.WithBody(oInit.Body.WithStatements(
                SyntaxFactory.List(oInit.Body.Statements.Where(st => !IsTargetCall(st, providerId, targetId, propertyName, out _))))));
            var eScrub = eRoot.ReplaceNode(eInit, eInit.WithBody(eInit.Body.WithStatements(
                SyntaxFactory.List(eInit.Body.Statements.Where(st => !IsTargetCall(st, providerId, targetId, propertyName, out _))))));
            return string.Equals(oScrub.ToFullString(), eScrub.ToFullString(), StringComparison.Ordinal);
        }

        private static bool TryExpression(Spec spec, string raw, out string expression)
        {
            expression = "";
            if (spec.TypeName == "System.String")
            {
                expression = SyntaxFactory.Literal(raw).ToString();
                return true;
            }
            if (spec.TypeName == "System.Boolean" && bool.TryParse(raw, out var b))
            {
                expression = b ? "true" : "false";
                return true;
            }
            if (spec.TypeName == "System.Int32"
                && int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i))
            {
                expression = i.ToString(CultureInfo.InvariantCulture);
                return true;
            }
            if (spec.EnumType != null && IsIdentifier(raw))
            {
                expression = spec.EnumType + "." + raw;
                return true;
            }
            return false;
        }

        /// <summary>True when the expression is one this editor could itself have emitted FOR THIS PROPERTY. The
        /// distinction matters: an enum-valued property is written as a bare dotted member, while every other
        /// supported type is written as a literal — so a dotted name where a LITERAL belongs (`Resources.Tip`, a
        /// const, a field) is the user's own code, not a value we produced, and overwriting it would silently change
        /// behaviour. The minimal-diff gate cannot protect it either: it scrubs every matching call from BOTH files
        /// before comparing, so a replaced value is invisible to it.</summary>
        private static bool IsRepresentableValue(Spec spec, ExpressionSyntax expression)
        {
            if (spec.EnumType != null)
            {
                // Pin the value to THIS enum, not merely to "some dotted name". Shape alone accepted an unrelated
                // constant (`UiDefaults.ValidationAlignment`) as editor-owned and overwrote it, while rejecting the
                // `global::`-qualified form of the very member this editor emits.
                if (expression is not (MemberAccessExpressionSyntax or IdentifierNameSyntax))
                    return false;
                string text = expression.ToString().Replace(" ", "").Replace("global::", "");
                if (!text.StartsWith(spec.EnumType + ".", StringComparison.Ordinal))
                    return false;
                string member = text.Substring(spec.EnumType.Length + 1);
                return member.Length > 0 && IsIdentifier(member);
            }
            return expression is LiteralExpressionSyntax
                || (expression is PrefixUnaryExpressionSyntax u && u.IsKind(SyntaxKind.UnaryMinusExpression)
                    && u.Operand is LiteralExpressionSyntax);
        }

        private static bool IsTargetCall(StatementSyntax statement, string providerId, string targetId,
            string propertyName, out SeparatedSyntaxList<ArgumentSyntax>? arguments)
        {
            arguments = null;
            if (statement is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax invocation }
                || invocation.Expression is not MemberAccessExpressionSyntax method
                || method.Name.Identifier.ValueText != "Set" + propertyName)
                return false;
            var receiver = Flatten(method.Expression);
            if (receiver.Count != 1 || receiver[0] != providerId) return false;
            var args = invocation.ArgumentList.Arguments;
            if (args.Count != 2) return false;
            var target = Flatten(args[0].Expression);
            if (target.Count != 1 || target[0] != targetId) return false;
            arguments = args;
            return true;
        }

        private static bool MentionsOwnerAssignment(StatementSyntax statement, string ownerId)
        {
            if (statement is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment })
                return false;
            var chain = Flatten(assignment.Left);
            return chain.Count >= 1 && chain[0] == ownerId;
        }

        private static Dictionary<string, string> FieldTypes(ClassDeclarationSyntax cls)
        {
            var fields = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var part in FormClassResolver.PartialsOf(cls))
                foreach (var declaration in part.Members.OfType<FieldDeclarationSyntax>())
                    foreach (var variable in declaration.Declaration.Variables)
                        fields[variable.Identifier.ValueText] = declaration.Declaration.Type.ToString();
            return fields;
        }

        private static List<string> Flatten(ExpressionSyntax expression)
        {
            var names = new List<string>();
            void Walk(ExpressionSyntax node)
            {
                switch (node)
                {
                    case MemberAccessExpressionSyntax member: Walk(member.Expression); names.Add(member.Name.Identifier.ValueText); break;
                    case ThisExpressionSyntax: break;
                    case IdentifierNameSyntax identifier: names.Add(identifier.Identifier.ValueText); break;
                    case ParenthesizedExpressionSyntax parenthesized: Walk(parenthesized.Expression); break;
                    default: names.Add("?" + node.Kind()); break;
                }
            }
            Walk(expression);
            return names;
        }

        /// <summary>True when the statement carries any comment or directive we would destroy by regenerating it.
        /// The scan must reach INSIDE the statement, not just its edges: a hand-written note between the provider's
        /// <c>SetX(target, value)</c> arguments hangs off an inner token, and an edge-only check dropped it silently.</summary>
        private static bool HasMeaningfulTrivia(StatementSyntax statement) =>
            statement.DescendantTrivia(descendIntoTrivia: true)
                .Concat(statement.GetLeadingTrivia())
                .Concat(statement.GetTrailingTrivia())
                .Any(t => !t.IsKind(SyntaxKind.WhitespaceTrivia) && !t.IsKind(SyntaxKind.EndOfLineTrivia));

        private static string LineIndent(SyntaxNode node)
        {
            var text = node.SyntaxTree.GetText();
            string line = text.Lines.GetLineFromPosition(node.SpanStart).ToString();
            return line.Substring(0, line.Length - line.TrimStart().Length);
        }

        private static bool IsIdentifier(string value) =>
            !string.IsNullOrEmpty(value) && SyntaxFacts.IsValidIdentifier(value);

        private static EditResult Failed(string reason) => new() { Mode = EditMode.Failed, Reason = reason };
    }
}
