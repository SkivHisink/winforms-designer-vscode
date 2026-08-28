using System;
using System.Collections.Generic;
using System.Linq;
using System.Windows.Forms;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    public enum InheritedOverrideEditMode { Insert, Replace, Remove, Noop, Failed }

    public sealed class InheritedOverrideEditRequest
    {
        public string SourceText { get; init; } = "";
        public string FieldId { get; init; } = "";
        public string FieldTypeName { get; init; } = "";
        public string EffectiveAccessibility { get; init; } = "";
        public string PropertyName { get; init; } = "";
        public string PropertyTypeName { get; init; } = "";
        public string ValueExpression { get; init; } = "";
        public string ExpectedBaseIdentityToken { get; init; } = "";
        public string ObservedBaseIdentityToken { get; init; } = "";
    }

    public sealed class InheritedOverrideEditResult
    {
        public bool Safe { get; init; }
        public InheritedOverrideEditMode Mode { get; init; }
        public string? NewText { get; init; }
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Source-first writer for derived-form overrides of inherited WinForms controls. It never edits the base source:
    /// the only accepted mutation is an insert/replace of one <c>this.inheritedField.Property = value;</c> assignment
    /// inside the derived form's InitializeComponent.
    /// </summary>
    public static class DesignerInheritedOverrideEditor
    {
        private static readonly HashSet<string> AccessibleFieldKinds = new(StringComparer.OrdinalIgnoreCase)
        {
            "public",
            "protected",
            "protected internal",
            "protectedinternal",
        };

        private static readonly HashSet<string> AllowlistedProperties = new(StringComparer.Ordinal)
        {
            "Location",
            "Size",
            "Bounds",
            "Anchor",
            "Dock",
            "Text",
            "Enabled",
            "Visible",
            "TabIndex",
        };

        public static InheritedOverrideEditResult TryApply(InheritedOverrideEditRequest request) =>
            TryApplyCore(request, null, null, liveTargetValidated: false);

        /// <summary>
        /// Apply an inherited override after the live designer host has resolved both the declared base field type
        /// and the actual component type. This overload is the only path that accepts custom/vendor Control types;
        /// the string-only overload deliberately remains restricted to framework controls.
        /// </summary>
        public static InheritedOverrideEditResult TryApply(
            InheritedOverrideEditRequest request,
            Type resolvedFieldType,
            Type resolvedRuntimeType) =>
            TryApplyCore(request, resolvedFieldType, resolvedRuntimeType, liveTargetValidated: false);

        /// <summary>net48 host-domain seam: the render child has already revalidated the live field, runtime type,
        /// accessibility, property metadata and base token. Kept internal so a protocol caller cannot self-attest.</summary>
        internal static InheritedOverrideEditResult TryApplyValidatedLiveTarget(InheritedOverrideEditRequest request) =>
            TryApplyCore(request, null, null, liveTargetValidated: true);

        private static InheritedOverrideEditResult TryApplyCore(
            InheritedOverrideEditRequest request,
            Type? resolvedFieldType,
            Type? resolvedRuntimeType,
            bool liveTargetValidated)
        {
            if (request == null) return Failed("request is null");
            if (!DesignerControlEditor.IsValidIdentifier(request.FieldId))
                return Failed("invalid inherited field id: " + request.FieldId);
            if (!DesignerControlEditor.IsValidIdentifier(request.PropertyName))
                return Failed("invalid property name: " + request.PropertyName);
            if (!AllowlistedProperties.Contains(request.PropertyName))
                return Failed("property is not allowlisted for inherited overrides: " + request.PropertyName);
            if (!IsAccessible(request.EffectiveAccessibility))
                return Failed("inherited field is not accessible from the derived designer source");
            if (!IsAuthorizedControlType(request.FieldTypeName, resolvedFieldType, resolvedRuntimeType, liveTargetValidated))
                return Failed("inherited field type is unknown, unresolved, or not a proven WinForms control: " + request.FieldTypeName);
            if (!BaseTokenMatches(request.ExpectedBaseIdentityToken, request.ObservedBaseIdentityToken))
                return Failed("base identity token is empty, unknown, or stale");

            ExpressionSyntax value;
            try
            {
                value = SyntaxFactory.ParseExpression(request.ValueExpression.Trim());
            }
            catch (Exception ex)
            {
                return Failed("value expression parse failed: " + ex.Message);
            }

            if (!IsSafePropertyExpression(request.PropertyName, request.PropertyTypeName, value, request.ValueExpression))
                return Failed("value expression is not safe for " + request.PropertyName);

            SyntaxNode root;
            try { root = CSharpSyntaxTree.ParseText(request.SourceText).GetRoot(); }
            catch (Exception ex) { return Failed("source parse failed: " + ex.Message); }

            var cls = FormClassResolver.FormClass(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return Failed("InitializeComponent not found");
            if (HasUnsafeStructureTrivia(init.Body))
                return Failed("InitializeComponent contains a directive, disabled text, or skipped tokens; refusing inherited override splice");
            if (DeclaresCurrentSourceField(cls, request.FieldId))
                return Failed("field is declared in current source, not inherited: " + request.FieldId);
            if (DeclaresLocal(init.Body, request.FieldId))
                return Failed("InitializeComponent declares a local that shadows inherited field: " + request.FieldId);
            if (HasAmbiguousTargetAssignment(init.Body, request.FieldId, request.PropertyName))
                return Failed("inherited override target assignment is ambiguous");

            var assignments = FindCanonicalTargetAssignments(init.Body, request.FieldId, request.PropertyName).ToList();
            if (assignments.Count > 1)
                return Failed("multiple assignments already target inherited field property: " + request.FieldId + "." + request.PropertyName);

            string valueText = request.ValueExpression.Trim();
            if (assignments.Count == 1)
            {
                var assignment = assignments[0];
                if (NormalizeExpression(assignment.Right) == NormalizeExpression(value))
                    return new InheritedOverrideEditResult { Safe = true, Mode = InheritedOverrideEditMode.Noop, NewText = request.SourceText, Reason = "unchanged" };

                if (HasUnsafeTrivia(assignment))
                    return Failed("target assignment contains a comment or directive");

                int start = assignment.Right.SpanStart;
                int end = assignment.Right.Span.End;
                string edited = request.SourceText.Substring(0, start) + valueText + request.SourceText.Substring(end);
                return Validate(request.SourceText, edited, request.FieldId, request.PropertyName, InheritedOverrideEditMode.Replace,
                    start, end, start + valueText.Length);
            }

            int insertPos = InsertPosition(request.SourceText, init.Body);
            string indent = StatementIndent(request.SourceText, init.Body);
            string nl = request.SourceText.Contains("\r\n") ? "\r\n" : "\n";
            string line = indent + "this." + request.FieldId + "." + request.PropertyName + " = " + valueText + ";" + nl;
            string inserted = request.SourceText.Substring(0, insertPos) + line + request.SourceText.Substring(insertPos);
            return Validate(request.SourceText, inserted, request.FieldId, request.PropertyName, InheritedOverrideEditMode.Insert,
                insertPos, insertPos, insertPos + line.Length);
        }

        /// <summary>Remove one canonical derived-source assignment and nothing else. This is the Reset half of the
        /// inherited override contract: the current compiled base is still revalidated by the caller, while this
        /// writer proves that only <c>this.&lt;field&gt;.&lt;property&gt; = ...;</c> disappears from the derived source.</summary>
        public static InheritedOverrideEditResult TryRemove(InheritedOverrideEditRequest request) =>
            TryRemoveCore(request, null, null, liveTargetValidated: false);

        /// <summary>Reset counterpart of <see cref="TryApply(InheritedOverrideEditRequest, Type, Type)"/>.</summary>
        public static InheritedOverrideEditResult TryRemove(
            InheritedOverrideEditRequest request,
            Type resolvedFieldType,
            Type resolvedRuntimeType) =>
            TryRemoveCore(request, resolvedFieldType, resolvedRuntimeType, liveTargetValidated: false);

        /// <summary>Reset counterpart of <see cref="TryApplyValidatedLiveTarget"/>.</summary>
        internal static InheritedOverrideEditResult TryRemoveValidatedLiveTarget(InheritedOverrideEditRequest request) =>
            TryRemoveCore(request, null, null, liveTargetValidated: true);

        private static InheritedOverrideEditResult TryRemoveCore(
            InheritedOverrideEditRequest request,
            Type? resolvedFieldType,
            Type? resolvedRuntimeType,
            bool liveTargetValidated)
        {
            if (request == null) return Failed("request is null");
            if (!DesignerControlEditor.IsValidIdentifier(request.FieldId))
                return Failed("invalid inherited field id: " + request.FieldId);
            if (!DesignerControlEditor.IsValidIdentifier(request.PropertyName))
                return Failed("invalid property name: " + request.PropertyName);
            if (!SupportsProperty(request.PropertyName, request.PropertyTypeName))
                return Failed("property/type is not supported for inherited overrides: " + request.PropertyName);
            if (!IsAccessible(request.EffectiveAccessibility))
                return Failed("inherited field is not accessible from the derived designer source");
            if (!IsAuthorizedControlType(request.FieldTypeName, resolvedFieldType, resolvedRuntimeType, liveTargetValidated))
                return Failed("inherited field type is unknown, unresolved, or not a proven WinForms control: " + request.FieldTypeName);
            if (!BaseTokenMatches(request.ExpectedBaseIdentityToken, request.ObservedBaseIdentityToken))
                return Failed("base identity token is empty, unknown, or stale");

            SyntaxNode root;
            try { root = CSharpSyntaxTree.ParseText(request.SourceText).GetRoot(); }
            catch (Exception ex) { return Failed("source parse failed: " + ex.Message); }

            var cls = FormClassResolver.FormClass(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return Failed("InitializeComponent not found");
            if (HasUnsafeStructureTrivia(init.Body))
                return Failed("InitializeComponent contains a directive, disabled text, or skipped tokens; refusing inherited override splice");
            if (DeclaresCurrentSourceField(cls, request.FieldId))
                return Failed("field is declared in current source, not inherited: " + request.FieldId);
            if (DeclaresLocal(init.Body, request.FieldId))
                return Failed("InitializeComponent declares a local that shadows inherited field: " + request.FieldId);
            if (HasAmbiguousTargetAssignment(init.Body, request.FieldId, request.PropertyName))
                return Failed("inherited override target assignment is ambiguous");

            var assignments = FindCanonicalTargetAssignments(init.Body, request.FieldId, request.PropertyName).ToList();
            if (assignments.Count > 1)
                return Failed("multiple assignments already target inherited field property: " + request.FieldId + "." + request.PropertyName);
            if (assignments.Count == 0)
                return new InheritedOverrideEditResult { Safe = true, Mode = InheritedOverrideEditMode.Noop, NewText = request.SourceText, Reason = "already inherited" };

            var statement = assignments[0].Parent as ExpressionStatementSyntax;
            if (statement == null || !ReferenceEquals(statement.Parent, init.Body))
                return Failed("inherited override target assignment is not a direct canonical statement");
            if (HasUnsafeTrivia(statement))
                return Failed("target assignment contains a comment or directive");

            int start = request.SourceText.LastIndexOf('\n', Math.Max(0, statement.SpanStart - 1)) + 1;
            int lineBreak = request.SourceText.IndexOf('\n', statement.Span.End);
            int end = lineBreak < 0 ? statement.Span.End : lineBreak + 1;
            if (request.SourceText.Substring(start, statement.SpanStart - start).Any(ch => ch != ' ' && ch != '\t')
                || request.SourceText.Substring(statement.Span.End, end - statement.Span.End).Any(ch => ch != '\r' && ch != '\n' && ch != ' ' && ch != '\t'))
                return Failed("target assignment does not occupy a removable source line");

            string edited = request.SourceText.Substring(0, start) + request.SourceText.Substring(end);
            return Validate(request.SourceText, edited, request.FieldId, request.PropertyName,
                InheritedOverrideEditMode.Remove, start, end, start);
        }

        /// <summary>Metadata-only half of the closed inherited-override property contract. The live engine uses this
        /// to expose only rows the source writer can actually persist; expression validation still happens in
        /// <see cref="TryApply(InheritedOverrideEditRequest)"/> immediately before the splice.</summary>
        public static bool SupportsProperty(string propertyName, string propertyTypeName)
        {
            string type = NormalizeTypeName(propertyTypeName);
            return propertyName switch
            {
                "Location" => TypeMatches(type, "System.Drawing.Point"),
                "Size" => TypeMatches(type, "System.Drawing.Size"),
                "Bounds" => TypeMatches(type, "System.Drawing.Rectangle"),
                "Anchor" => TypeMatches(type, "System.Windows.Forms.AnchorStyles"),
                "Dock" => TypeMatches(type, "System.Windows.Forms.DockStyle"),
                "Text" => TypeMatches(type, "System.String"),
                "Enabled" => TypeMatches(type, "System.Boolean"),
                "Visible" => TypeMatches(type, "System.Boolean"),
                "TabIndex" => TypeMatches(type, "System.Int32"),
                _ => false,
            };
        }

        public static bool IsGeometryProperty(string propertyName) =>
            propertyName is "Location" or "Size" or "Bounds";

        public static bool SupportsInheritedField(string fieldId, string fieldTypeName)
        {
            return DesignerControlEditor.IsValidIdentifier(fieldId)
                && IsKnownWinFormsControlType(fieldTypeName);
        }

        /// <summary>Live-type counterpart used for a resolved custom/vendor base field.</summary>
        public static bool SupportsInheritedField(string fieldId, Type resolvedFieldType, Type resolvedRuntimeType)
        {
            return DesignerControlEditor.IsValidIdentifier(fieldId)
                && IsResolvedControlType(resolvedFieldType, resolvedRuntimeType);
        }

        private static bool IsAccessible(string value)
        {
            var normalized = (value ?? "").Trim();
            return normalized.Length > 0
                && !IsUnknownToken(normalized)
                && AccessibleFieldKinds.Contains(normalized.Replace("_", " ", StringComparison.Ordinal).Replace("-", " ", StringComparison.Ordinal));
        }

        private static bool IsKnownWinFormsControlType(string value)
        {
            var typeName = NormalizeTypeName(value);
            if (typeName.Length == 0 || IsUnknownToken(typeName)) return false;
            Type? type;
            try { type = typeof(Control).Assembly.GetType(typeName, throwOnError: false, ignoreCase: false); }
            catch { type = null; }
            return type != null && typeof(Control).IsAssignableFrom(type);
        }

        private static bool IsAuthorizedControlType(string advertisedTypeName, Type? resolvedFieldType,
            Type? resolvedRuntimeType, bool liveTargetValidated)
        {
            string advertised = NormalizeTypeName(advertisedTypeName);
            if (liveTargetValidated)
                return advertised.Length > 0 && !IsUnknownToken(advertised);
            if (resolvedFieldType == null || resolvedRuntimeType == null)
                return IsKnownWinFormsControlType(advertised);

            string actualTypeName = resolvedFieldType.FullName ?? resolvedFieldType.Name;
            return string.Equals(advertised, actualTypeName, StringComparison.Ordinal)
                && IsResolvedControlType(resolvedFieldType, resolvedRuntimeType);
        }

        private static bool IsResolvedControlType(Type resolvedFieldType, Type resolvedRuntimeType)
        {
            try
            {
                return typeof(Control).IsAssignableFrom(resolvedFieldType)
                    && typeof(Control).IsAssignableFrom(resolvedRuntimeType)
                    && resolvedFieldType.IsAssignableFrom(resolvedRuntimeType);
            }
            catch
            {
                return false;
            }
        }

        private static bool BaseTokenMatches(string expected, string observed)
        {
            expected = (expected ?? "").Trim();
            observed = (observed ?? "").Trim();
            return expected.Length > 0
                && observed.Length > 0
                && !IsUnknownToken(expected)
                && !IsUnknownToken(observed)
                && string.Equals(expected, observed, StringComparison.Ordinal);
        }

        private static bool IsUnknownToken(string value) =>
            value.Equals("unknown", StringComparison.OrdinalIgnoreCase)
            || value.Equals("unresolved", StringComparison.OrdinalIgnoreCase)
            || value.Equals("vendor", StringComparison.OrdinalIgnoreCase)
            || value.Equals("missing", StringComparison.OrdinalIgnoreCase);

        private static string NormalizeTypeName(string value)
        {
            value = (value ?? "").Trim();
            if (value.StartsWith("global::", StringComparison.Ordinal)) value = value.Substring("global::".Length);
            return value;
        }

        private static bool IsSafePropertyExpression(string propertyName, string propertyTypeName, ExpressionSyntax value, string raw)
        {
            if (!IsSingleExpression(value, raw)) return false;
            string type = NormalizeTypeName(propertyTypeName);
            return propertyName switch
            {
                "Location" => TypeMatches(type, "System.Drawing.Point") && IsPointValue(value),
                "Size" => TypeMatches(type, "System.Drawing.Size") && IsSizeValue(value),
                "Bounds" => TypeMatches(type, "System.Drawing.Rectangle") && IsRectangleValue(value),
                "Anchor" => TypeMatches(type, "System.Windows.Forms.AnchorStyles") && IsAnchorStylesValue(value),
                "Dock" => TypeMatches(type, "System.Windows.Forms.DockStyle") && IsDockStyleValue(value),
                "Text" => TypeMatches(type, "System.String") && IsStringValue(value),
                "Enabled" => TypeMatches(type, "System.Boolean") && IsBooleanLiteral(value),
                "Visible" => TypeMatches(type, "System.Boolean") && IsBooleanLiteral(value),
                "TabIndex" => TypeMatches(type, "System.Int32") && IsNonNegativeInt(value),
                _ => false,
            };
        }

        private static bool TypeMatches(string actual, string expected) =>
            string.Equals(actual, expected, StringComparison.Ordinal)
            || string.Equals(actual, expected.Replace("System.", "", StringComparison.Ordinal), StringComparison.Ordinal)
            || (expected == "System.String" && actual == "string")
            || (expected == "System.Boolean" && actual == "bool")
            || (expected == "System.Int32" && actual == "int");

        private static bool IsSingleExpression(ExpressionSyntax expr, string raw)
        {
            if (expr.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error)) return false;
            if (expr.ToString().Trim() != raw.Trim()) return false;
            foreach (var node in expr.DescendantNodesAndSelf())
            {
                if (node is AssignmentExpressionSyntax) return false;
                if (node is AnonymousFunctionExpressionSyntax) return false;
                if (node is AwaitExpressionSyntax) return false;
                if (node.IsKind(SyntaxKind.PreIncrementExpression) || node.IsKind(SyntaxKind.PostIncrementExpression)
                    || node.IsKind(SyntaxKind.PreDecrementExpression) || node.IsKind(SyntaxKind.PostDecrementExpression))
                    return false;
                if (node is InvocationExpressionSyntax) return false;
                if (node is MemberAccessExpressionSyntax member && IsRootedAtThis(member)) return false;
            }
            return true;
        }

        private static bool IsPointValue(ExpressionSyntax value) =>
            IsNewValueType(value, "System.Drawing.Point", "Point", IsSignedIntLiteral, IsSignedIntLiteral);

        private static bool IsSizeValue(ExpressionSyntax value) =>
            IsNewValueType(value, "System.Drawing.Size", "Size", IsNonNegativeInt, IsNonNegativeInt);

        private static bool IsRectangleValue(ExpressionSyntax value) =>
            IsNewValueType(value, "System.Drawing.Rectangle", "Rectangle",
                IsSignedIntLiteral, IsSignedIntLiteral, IsNonNegativeInt, IsNonNegativeInt);

        private static bool IsNewValueType(ExpressionSyntax value, string fqn, string shortName,
            params Func<ExpressionSyntax, bool>[] argumentChecks)
        {
            if (value is not ObjectCreationExpressionSyntax oc) return false;
            string type = NormalizeTypeName(oc.Type.ToString());
            if (!string.Equals(type, fqn, StringComparison.Ordinal) && !string.Equals(type, shortName, StringComparison.Ordinal))
                return false;
            var args = oc.ArgumentList?.Arguments;
            if (args == null || args.Value.Count != argumentChecks.Length) return false;
            for (int i = 0; i < argumentChecks.Length; i++)
            {
                if (args.Value[i].NameColon != null || !args.Value[i].RefKindKeyword.IsKind(SyntaxKind.None)
                    || !argumentChecks[i](args.Value[i].Expression)) return false;
            }
            return true;
        }

        private static bool IsAnchorStylesValue(ExpressionSyntax value)
        {
            if (value is BinaryExpressionSyntax binary && binary.IsKind(SyntaxKind.BitwiseOrExpression))
                return IsAnchorStylesValue(binary.Left) && IsAnchorStylesValue(binary.Right);
            if (value is ParenthesizedExpressionSyntax parenthesized)
                return IsAnchorStylesValue(parenthesized.Expression);
            return value is MemberAccessExpressionSyntax member
                && IsEnumType(member.Expression, "System.Windows.Forms.AnchorStyles", "AnchorStyles")
                && member.Name.Identifier.ValueText is "None" or "Top" or "Bottom" or "Left" or "Right";
        }

        private static bool IsDockStyleValue(ExpressionSyntax value)
        {
            if (value is ParenthesizedExpressionSyntax parenthesized)
                return IsDockStyleValue(parenthesized.Expression);
            return value is MemberAccessExpressionSyntax member
                && IsEnumType(member.Expression, "System.Windows.Forms.DockStyle", "DockStyle")
                && member.Name.Identifier.ValueText is "None" or "Top" or "Bottom" or "Left" or "Right" or "Fill";
        }

        private static bool IsEnumType(ExpressionSyntax expression, string fqn, string shortName)
        {
            string text = NormalizeTypeName(expression.ToString());
            return string.Equals(text, fqn, StringComparison.Ordinal) || string.Equals(text, shortName, StringComparison.Ordinal);
        }

        private static bool IsStringValue(ExpressionSyntax value) =>
            value.IsKind(SyntaxKind.StringLiteralExpression)
            || value.IsKind(SyntaxKind.NullLiteralExpression)
            || value.ToString() == "string.Empty"
            || value.ToString() == "System.String.Empty";

        private static bool IsBooleanLiteral(ExpressionSyntax value) =>
            value.IsKind(SyntaxKind.TrueLiteralExpression) || value.IsKind(SyntaxKind.FalseLiteralExpression);

        private static bool IsNonNegativeInt(ExpressionSyntax value) =>
            TryIntLiteral(value, out int parsed) && parsed >= 0;

        private static bool IsSignedIntLiteral(ExpressionSyntax value) => TryIntLiteral(value, out _);

        private static bool TryIntLiteral(ExpressionSyntax value, out int parsed)
        {
            parsed = 0;
            if (value is PrefixUnaryExpressionSyntax prefix
                && (prefix.IsKind(SyntaxKind.UnaryPlusExpression) || prefix.IsKind(SyntaxKind.UnaryMinusExpression))
                && prefix.Operand.IsKind(SyntaxKind.NumericLiteralExpression))
                return int.TryParse(value.ToString(), out parsed);
            return value.IsKind(SyntaxKind.NumericLiteralExpression) && int.TryParse(value.ToString(), out parsed);
        }

        private static bool DeclaresCurrentSourceField(ClassDeclarationSyntax cls, string fieldId)
        {
            foreach (var part in FormClassResolver.PartialsOf(cls))
                foreach (var field in part.Members.OfType<FieldDeclarationSyntax>())
                    if (field.Declaration.Variables.Any(v => v.Identifier.ValueText == fieldId))
                        return true;
            return false;
        }

        private static bool DeclaresLocal(BlockSyntax initBody, string fieldId) =>
            initBody.DescendantNodes().OfType<VariableDeclaratorSyntax>().Any(v => v.Identifier.ValueText == fieldId);

        private static IEnumerable<AssignmentExpressionSyntax> FindCanonicalTargetAssignments(
            BlockSyntax initBody,
            string fieldId,
            string propertyName)
        {
            return initBody.Statements
                .OfType<ExpressionStatementSyntax>()
                .Select(s => s.Expression)
                .OfType<AssignmentExpressionSyntax>()
                .Where(a => a.IsKind(SyntaxKind.SimpleAssignmentExpression)
                         && IsCanonicalTarget(a.Left, fieldId, propertyName));
        }

        private static bool HasAmbiguousTargetAssignment(BlockSyntax initBody, string fieldId, string propertyName)
        {
            foreach (var assignment in initBody.DescendantNodes().OfType<AssignmentExpressionSyntax>())
            {
                if (IsCanonicalTarget(assignment.Left, fieldId, propertyName))
                {
                    bool directCanonicalStatement = assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                        && assignment.Parent is ExpressionStatementSyntax statement
                        && ReferenceEquals(statement.Parent, initBody);
                    if (!directCanonicalStatement) return true;
                    continue;
                }
                var chain = Flatten(assignment.Left);
                if (chain.Count == 2 && chain[0] == fieldId && chain[1] == propertyName)
                    return true;
            }
            return false;
        }

        private static bool IsCanonicalTarget(ExpressionSyntax left, string fieldId, string propertyName) =>
            left is MemberAccessExpressionSyntax property
            && property.Name.Identifier.ValueText == propertyName
            && property.Expression is MemberAccessExpressionSyntax field
            && field.Name.Identifier.ValueText == fieldId
            && field.Expression is ThisExpressionSyntax;

        private static List<string> Flatten(ExpressionSyntax expr)
        {
            var names = new List<string>();
            void Walk(ExpressionSyntax e)
            {
                switch (e)
                {
                    case MemberAccessExpressionSyntax m:
                        Walk(m.Expression);
                        names.Add(m.Name.Identifier.ValueText);
                        break;
                    case ThisExpressionSyntax:
                        break;
                    case IdentifierNameSyntax id:
                        names.Add(id.Identifier.ValueText);
                        break;
                    case ParenthesizedExpressionSyntax p:
                        Walk(p.Expression);
                        break;
                    default:
                        names.Add("?" + e.Kind());
                        break;
                }
            }
            Walk(expr);
            return names;
        }

        private static int InsertPosition(string sourceText, BlockSyntax initBody)
        {
            foreach (var statement in initBody.Statements.Reverse())
            {
                if (IsTrailingLayoutCall(statement)) continue;
                int nl = sourceText.IndexOf('\n', statement.Span.End);
                return nl < 0 ? statement.Span.End : nl + 1;
            }
            return initBody.CloseBraceToken.SpanStart;
        }

        private static bool IsTrailingLayoutCall(StatementSyntax statement)
        {
            if (statement is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax invocation }) return false;
            if (invocation.Expression is not MemberAccessExpressionSyntax member) return false;
            if (member.Expression is not ThisExpressionSyntax) return false;
            return member.Name.Identifier.ValueText is "ResumeLayout" or "PerformLayout";
        }

        private static string StatementIndent(string sourceText, BlockSyntax initBody)
        {
            if (initBody.Statements.Count > 0)
            {
                var first = initBody.Statements[0];
                int lineStart = sourceText.LastIndexOf('\n', Math.Max(0, first.SpanStart - 1)) + 1;
                int i = lineStart;
                while (i < sourceText.Length && (sourceText[i] == ' ' || sourceText[i] == '\t')) i++;
                return sourceText.Substring(lineStart, i - lineStart);
            }

            int closeLineStart = sourceText.LastIndexOf('\n', Math.Max(0, initBody.CloseBraceToken.SpanStart - 1)) + 1;
            int j = closeLineStart;
            while (j < sourceText.Length && (sourceText[j] == ' ' || sourceText[j] == '\t')) j++;
            return sourceText.Substring(closeLineStart, j - closeLineStart) + "    ";
        }

        private static InheritedOverrideEditResult Validate(
            string original,
            string edited,
            string fieldId,
            string propertyName,
            InheritedOverrideEditMode mode,
            int replacedStart,
            int replacedEnd,
            int editedEnd)
        {
            var diagnostics = CSharpSyntaxTree.ParseText(edited).GetDiagnostics();
            if (diagnostics.Any(d => d.Severity == DiagnosticSeverity.Error))
                return Failed("edited source has syntax errors");

            if (!OnlyTargetChanged(original, edited, fieldId, propertyName, mode))
                return Failed("edit changed more than the inherited override assignment");

            if (original.Substring(0, replacedStart) != edited.Substring(0, replacedStart))
                return Failed("edit changed text before the intended splice");
            if (original.Substring(replacedEnd) != edited.Substring(editedEnd))
                return Failed("edit changed text after the intended splice");

            return new InheritedOverrideEditResult { Safe = true, Mode = mode, NewText = edited };
        }

        public static bool OnlyTargetChanged(string original, string edited, string fieldId, string propertyName,
            InheritedOverrideEditMode mode)
        {
            var (origNon, origTarget) = Classify(original, fieldId, propertyName);
            var (editNon, editTarget) = Classify(edited, fieldId, propertyName);
            int expectedDelta = mode == InheritedOverrideEditMode.Insert ? 1
                : mode == InheritedOverrideEditMode.Remove ? -1 : 0;
            if (editTarget != origTarget + expectedDelta) return false;
            return MultisetEqual(origNon, editNon) && MultisetEqual(FieldNames(original), FieldNames(edited));
        }

        private static (List<string> nonTarget, int targetCount) Classify(string code, string fieldId, string propertyName)
        {
            var nonTarget = new List<string>();
            int targetCount = 0;
            var init = FormClassResolver.InitMethod(CSharpSyntaxTree.ParseText(code).GetRoot());
            if (init?.Body == null) return (nonTarget, targetCount);
            foreach (var statement in init.Body.Statements)
            {
                if (statement is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment }
                    && IsCanonicalTarget(assignment.Left, fieldId, propertyName))
                    targetCount++;
                else
                    nonTarget.Add(NormalizeStatement(statement));
            }
            return (nonTarget, targetCount);
        }

        private static List<string> FieldNames(string code)
        {
            var cls = FormClassResolver.FormClass(CSharpSyntaxTree.ParseText(code).GetRoot());
            if (cls == null) return new List<string>();
            return FormClassResolver.FieldNamesOf(cls).ToList();
        }

        private static bool MultisetEqual(List<string> a, List<string> b)
        {
            if (a.Count != b.Count) return false;
            var ca = Counter(a);
            var cb = Counter(b);
            if (ca.Count != cb.Count) return false;
            foreach (var item in ca)
                if (!cb.TryGetValue(item.Key, out int count) || count != item.Value)
                    return false;
            return true;
        }

        private static Dictionary<string, int> Counter(IEnumerable<string> values)
        {
            var result = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var value in values)
                result[value] = result.TryGetValue(value, out int count) ? count + 1 : 1;
            return result;
        }

        private static string NormalizeStatement(StatementSyntax statement) =>
            new string(statement.ToString().Where(c => !char.IsWhiteSpace(c)).ToArray());

        private static string NormalizeExpression(ExpressionSyntax expression) =>
            new string(expression.ToString().Where(c => !char.IsWhiteSpace(c)).ToArray());

        private static bool HasUnsafeTrivia(SyntaxNode node)
        {
            foreach (var trivia in node.DescendantTrivia(descendIntoTrivia: true))
            {
                if (trivia.IsKind(SyntaxKind.WhitespaceTrivia) || trivia.IsKind(SyntaxKind.EndOfLineTrivia))
                    continue;
                return true;
            }
            return false;
        }

        private static bool HasUnsafeStructureTrivia(SyntaxNode node)
        {
            foreach (var trivia in node.DescendantTrivia(descendIntoTrivia: true))
            {
                // Ordinary and documentation comments are ubiquitous in Visual Studio-generated designer files and
                // are byte-preserved by the exact substring splice. Preprocessor structure/disabled text and parser
                // recovery tokens can change which statements are active, so those remain fail-closed.
                if (trivia.IsDirective
                    || trivia.IsKind(SyntaxKind.DisabledTextTrivia)
                    || trivia.IsKind(SyntaxKind.SkippedTokensTrivia))
                    return true;
            }
            return false;
        }

        private static bool IsRootedAtThis(ExpressionSyntax expression) => expression switch
        {
            MemberAccessExpressionSyntax member => IsRootedAtThis(member.Expression),
            ParenthesizedExpressionSyntax parenthesized => IsRootedAtThis(parenthesized.Expression),
            ThisExpressionSyntax => true,
            _ => false,
        };

        private static InheritedOverrideEditResult Failed(string reason) =>
            new() { Safe = false, Mode = InheritedOverrideEditMode.Failed, Reason = reason };
    }
}
