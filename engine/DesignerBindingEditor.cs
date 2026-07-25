using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// One WinForms <c>ControlBindingsCollection</c> entry. The editor deliberately models the stable,
    /// designer-generated <c>Binding</c> constructor subset instead of exposing arbitrary C# expressions:
    /// target property, a component field used as the data source, data member, formatting switch, update mode,
    /// and an optional format string.
    /// </summary>
    public sealed class BindingItem
    {
        public string PropertyName { get; set; } = "";
        public string DataSourceId { get; set; } = "";
        public string DataMember { get; set; } = "";
        public bool FormattingEnabled { get; set; }
        public string UpdateMode { get; set; } = "OnValidation";
        public string FormatString { get; set; } = "";
    }

    /// <summary>A source field that can be selected by the bindings editor.</summary>
    public sealed class BindingSourceItem
    {
        public string Id { get; init; } = "";
        public string TypeName { get; init; } = "";
    }

    /// <summary>Read side of the DataBindings editor.</summary>
    public sealed class BindingItemsResult
    {
        public bool Ok { get; init; }
        public List<BindingItem> Bindings { get; init; } = new();
        public List<BindingSourceItem> Sources { get; init; } = new();
        public string Reason { get; init; } = "";
    }

    /// <summary>Read side of a BindingSource/ListControl/DataGridView DataSource property.</summary>
    public sealed class DataSourceResult
    {
        public bool Ok { get; init; }
        /// <summary>"none", "component", or "type".</summary>
        public string Kind { get; init; } = "none";
        /// <summary>Component field id or type name, depending on <see cref="Kind"/>.</summary>
        public string Value { get; init; } = "";
        public List<BindingSourceItem> Components { get; init; } = new();
        public string Reason { get; init; } = "";
    }

    /// <summary>
    /// Pure-source editor for the canonical WinForms shape:
    /// <code>
    /// this.nameTextBox.DataBindings.Add(
    ///     new System.Windows.Forms.Binding("Text", this.customerBindingSource, "Name", true));
    /// </code>
    ///
    /// Existing expressions outside the closed constructor subset are surfaced read-only. Writes rebuild only
    /// the selected owner's <c>DataBindings.Add</c> statements, emit every user value through Roslyn literals,
    /// and are accepted only when <see cref="OnlyBindingsChanged"/> proves that no other statement changed.
    /// </summary>
    public static class DesignerBindingEditor
    {
        private const string BindingType = "System.Windows.Forms.Binding";
        private const string UpdateModeType = "System.Windows.Forms.DataSourceUpdateMode";

        private static readonly HashSet<string> UpdateModes = new(StringComparer.Ordinal)
        {
            "Never",
            "OnPropertyChanged",
            "OnValidation",
        };

        public static BindingItemsResult ListBindings(string sourceText, string ownerId)
        {
            if (!IsIdentifier(ownerId))
                return FailedList("invalid owner id: " + ownerId);

            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FormClassResolver.FormClass(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null)
                return FailedList("InitializeComponent not found");

            var fields = FieldTypes(cls);
            if (!fields.ContainsKey(ownerId))
                return FailedList("unknown component id: " + ownerId);

            var sources = fields
                .Where(kv => kv.Key != ownerId && IsBindingSourceType(kv.Value))
                .Select(kv => new BindingSourceItem { Id = kv.Key, TypeName = kv.Value })
                .OrderBy(x => x.Id, StringComparer.Ordinal)
                .ToList();
            var sourceIds = new HashSet<string>(sources.Select(x => x.Id), StringComparer.Ordinal);

            var bindings = new List<BindingItem>();
            foreach (var st in init.Body.Statements)
            {
                if (!TryBindingCall(st, ownerId, out var creation))
                    continue;
                if (creation == null)
                    return new BindingItemsResult
                    {
                        Ok = false,
                        Sources = sources,
                        Reason = "DataBindings contains an unsupported Add expression",
                    };
                if (!TryReadBinding(creation!, sourceIds, out var item, out var reason))
                    return new BindingItemsResult { Ok = false, Sources = sources, Reason = reason };
                bindings.Add(item!);
            }

            if (bindings.Select(x => x.PropertyName).Distinct(StringComparer.Ordinal).Count() != bindings.Count)
                return new BindingItemsResult
                {
                    Ok = false,
                    Sources = sources,
                    Reason = ownerId + ".DataBindings contains duplicate target properties",
                };

            return new BindingItemsResult { Ok = true, Bindings = bindings, Sources = sources };
        }

        public static EditResult SetBindings(string sourceText, string ownerId, IReadOnlyList<BindingItem> desired)
        {
            if (!IsIdentifier(ownerId))
                return FailedEdit("invalid owner id: " + ownerId);

            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FormClassResolver.FormClass(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null)
                return FailedEdit("InitializeComponent not found");

            var fields = FieldTypes(cls);
            if (!fields.ContainsKey(ownerId))
                return FailedEdit("unknown component id: " + ownerId);

            // The current shape must be representable before it may be replaced. This is the data-loss gate for
            // custom Binding expressions, eventful subclasses, format providers, and non-component data sources.
            var current = ListBindings(sourceText, ownerId);
            if (!current.Ok)
                return FailedEdit(current.Reason);

            var sourceIds = new HashSet<string>(current.Sources.Select(x => x.Id), StringComparer.Ordinal);
            var normalized = new List<BindingItem>();
            var propertyNames = new HashSet<string>(StringComparer.Ordinal);
            foreach (var raw in desired ?? Array.Empty<BindingItem>())
            {
                var item = new BindingItem
                {
                    PropertyName = raw?.PropertyName?.Trim() ?? "",
                    DataSourceId = raw?.DataSourceId?.Trim() ?? "",
                    DataMember = raw?.DataMember ?? "",
                    FormattingEnabled = raw?.FormattingEnabled ?? false,
                    UpdateMode = string.IsNullOrWhiteSpace(raw?.UpdateMode) ? "OnValidation" : raw!.UpdateMode.Trim(),
                    FormatString = raw?.FormatString ?? "",
                };
                if (!IsIdentifier(item.PropertyName))
                    return FailedEdit("invalid bound property name: " + item.PropertyName);
                if (!propertyNames.Add(item.PropertyName))
                    return FailedEdit("duplicate binding for property: " + item.PropertyName);
                if (!sourceIds.Contains(item.DataSourceId))
                    return FailedEdit("unknown or unsupported data source: " + item.DataSourceId);
                if (!UpdateModes.Contains(item.UpdateMode))
                    return FailedEdit("unsupported update mode: " + item.UpdateMode);
                if (item.DataMember.Length > 1024 || item.FormatString.Length > 256)
                    return FailedEdit("binding text is too long");
                if (item.FormatString.Length > 0 && !item.FormattingEnabled)
                    return FailedEdit("a format string requires formatting to be enabled");
                normalized.Add(item);
            }

            var oldStatements = init.Body.Statements.ToList();
            int anchor = -1;
            var kept = new List<StatementSyntax>();
            foreach (var st in oldStatements)
            {
                if (TryBindingCall(st, ownerId, out _))
                {
                    if (HasMeaningfulTrivia(st))
                        return FailedEdit("a DataBindings statement contains comments or directives");
                    if (anchor < 0) anchor = kept.Count;
                    continue;
                }
                kept.Add(st);
            }

            if (anchor < 0)
            {
                int ownerAssignment = kept.FindLastIndex(st => IsOwnerAssignment(st, ownerId));
                if (ownerAssignment < 0)
                    return FailedEdit("no assignment references " + ownerId + " to anchor DataBindings");
                anchor = ownerAssignment + 1;
            }

            string nl = sourceText.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
            string indent = BodyIndent(init);
            var block = normalized.Select(x => BindingStatement(ownerId, x, indent, nl)).ToList();
            kept.InsertRange(Math.Min(anchor, kept.Count), block);

            var newInit = init.WithBody(init.Body.WithStatements(SyntaxFactory.List(kept)));
            var newText = root.ReplaceNode(init, newInit).ToFullString();
            return new EditResult { NewText = newText, Mode = EditMode.Replace };
        }

        /// <summary>Read a canonical <c>owner.DataSource = null/this.field/typeof(Type)</c> assignment.</summary>
        public static DataSourceResult GetDataSource(string sourceText, string ownerId)
        {
            if (!IsIdentifier(ownerId))
                return FailedDataSource("invalid owner id: " + ownerId);
            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            var cls = FormClassResolver.FormClass(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null)
                return FailedDataSource("InitializeComponent not found");

            var fields = FieldTypes(cls);
            if (!fields.TryGetValue(ownerId, out var ownerType) || !SupportsDataSource(ownerType))
                return FailedDataSource("component does not expose the supported DataSource workflow: " + ownerId);

            var components = fields
                .Where(kv => kv.Key != ownerId && IsBindingSourceType(kv.Value))
                .Select(kv => new BindingSourceItem { Id = kv.Key, TypeName = kv.Value })
                .OrderBy(x => x.Id, StringComparer.Ordinal)
                .ToList();
            var componentIds = new HashSet<string>(components.Select(x => x.Id), StringComparer.Ordinal);

            AssignmentExpressionSyntax? current = null;
            foreach (var st in init.Body.Statements)
            {
                if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment })
                    continue;
                var left = Flatten(assignment.Left);
                if (left.Count == 2 && left[0] == ownerId && left[1] == "DataSource")
                    current = assignment;
            }
            if (current == null)
                return new DataSourceResult { Ok = true, Kind = "none", Components = components };
            if (current.Right.DescendantTrivia(descendIntoTrivia: true).Any(t =>
                    !t.IsKind(SyntaxKind.WhitespaceTrivia) && !t.IsKind(SyntaxKind.EndOfLineTrivia)))
                return new DataSourceResult { Ok = false, Components = components, Reason = "DataSource expression contains comments or directives" };
            if (current.Right.IsKind(SyntaxKind.NullLiteralExpression))
                return new DataSourceResult { Ok = true, Kind = "none", Components = components };
            if (TryFieldReference(current.Right, out var fieldId) && componentIds.Contains(fieldId!))
                return new DataSourceResult { Ok = true, Kind = "component", Value = fieldId!, Components = components };
            if (current.Right is TypeOfExpressionSyntax typeOf && IsSafeTypeName(typeOf.Type.ToString()))
                return new DataSourceResult { Ok = true, Kind = "type", Value = typeOf.Type.ToString(), Components = components };
            return new DataSourceResult { Ok = false, Components = components, Reason = "DataSource is not null, a supported component field, or typeof(Type)" };
        }

        /// <summary>Set DataSource to null, an existing compatible component field, or a lexically safe typeof(Type).</summary>
        public static EditResult SetDataSource(string sourceText, string ownerId, string kind, string value)
        {
            var current = GetDataSource(sourceText, ownerId);
            if (!current.Ok)
                return FailedEdit(current.Reason);

            string expression;
            switch (kind ?? "")
            {
                case "none":
                    expression = "null";
                    break;
                case "component":
                    string component = value?.Trim() ?? "";
                    if (!current.Components.Any(x => x.Id == component))
                        return FailedEdit("unknown or unsupported DataSource component: " + component);
                    expression = "this." + component;
                    break;
                case "type":
                    string typeName = value?.Trim() ?? "";
                    if (!IsSafeTypeName(typeName))
                        return FailedEdit("invalid DataSource type name: " + typeName);
                    expression = "typeof(" + typeName + ")";
                    break;
                default:
                    return FailedEdit("unsupported DataSource kind: " + kind);
            }
            return DesignerPropertyEditor.EditProperty(sourceText, ownerId, "DataSource", expression);
        }

        public static bool OnlyBindingsChanged(string original, string edited, string ownerId)
        {
            if (!IsIdentifier(ownerId))
                return false;

            var oRoot = CSharpSyntaxTree.ParseText(original).GetRoot();
            var eRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            if (oRoot.ContainsDiagnostics || eRoot.ContainsDiagnostics)
                return false;

            var oInit = FormClassResolver.InitMethod(oRoot);
            var eInit = FormClassResolver.InitMethod(eRoot);
            if (oInit?.Body == null || eInit?.Body == null)
                return false;

            if (ListBindings(edited, ownerId).Ok == false)
                return false;

            var oBindings = oInit.Body.Statements.Where(st => TryBindingCall(st, ownerId, out _)).ToList();
            var eBindings = eInit.Body.Statements.Where(st => TryBindingCall(st, ownerId, out _)).ToList();
            if (oBindings.Any(HasMeaningfulTrivia) || eBindings.Any(HasMeaningfulTrivia))
                return false;

            var oNon = oInit.Body.Statements.Where(st => !TryBindingCall(st, ownerId, out _)).ToList();
            var eNon = eInit.Body.Statements.Where(st => !TryBindingCall(st, ownerId, out _)).ToList();
            if (!oNon.Select(x => x.ToFullString()).SequenceEqual(eNon.Select(x => x.ToFullString()), StringComparer.Ordinal))
                return false;

            // Compare the complete files after substituting the same non-binding body. That guards fields, sibling
            // methods/classes, usings, attributes and every other form member, not only InitializeComponent.
            var oScrubbed = oRoot.ReplaceNode(oInit, oInit.WithBody(oInit.Body.WithStatements(SyntaxFactory.List(oNon))));
            var eScrubbed = eRoot.ReplaceNode(eInit, eInit.WithBody(eInit.Body.WithStatements(SyntaxFactory.List(eNon))));
            return string.Equals(oScrubbed.ToFullString(), eScrubbed.ToFullString(), StringComparison.Ordinal);
        }

        private static bool TryReadBinding(ObjectCreationExpressionSyntax creation, HashSet<string> sourceIds,
            out BindingItem? item, out string reason)
        {
            item = null;
            reason = "";
            if (!IsBindingType(creation.Type) || creation.Initializer != null)
            {
                reason = "DataBindings contains an unsupported Binding construction";
                return false;
            }

            var args = creation.ArgumentList?.Arguments ?? default;
            int count = args.Count;
            if (count < 3 || count > 7)
            {
                reason = "DataBindings contains an unsupported Binding constructor";
                return false;
            }
            if (!TryStringLiteral(args[0].Expression, out var propertyName) || !IsIdentifier(propertyName!))
            {
                reason = "Binding target property is not a literal identifier";
                return false;
            }
            if (!TryFieldReference(args[1].Expression, out var sourceId) || !sourceIds.Contains(sourceId!))
            {
                reason = "Binding data source is not an available component field";
                return false;
            }
            if (!TryStringLiteral(args[2].Expression, out var member))
            {
                reason = "Binding data member is not a string literal";
                return false;
            }

            bool formatting = false;
            if (count >= 4 && !TryBoolLiteral(args[3].Expression, out formatting))
            {
                reason = "Binding formatting flag is not a bool literal";
                return false;
            }

            string updateMode = "OnValidation";
            if (count >= 5 && !TryUpdateMode(args[4].Expression, out updateMode))
            {
                reason = "Binding update mode is not supported";
                return false;
            }

            if (count >= 6 && !args[5].Expression.IsKind(SyntaxKind.NullLiteralExpression))
            {
                reason = "Binding null-value expression is not supported";
                return false;
            }

            string format = "";
            if (count >= 7)
            {
                if (!TryStringLiteral(args[6].Expression, out var parsedFormat))
                {
                    reason = "Binding format string is not a literal";
                    return false;
                }
                format = parsedFormat!;
            }

            item = new BindingItem
            {
                PropertyName = propertyName!,
                DataSourceId = sourceId!,
                DataMember = member!,
                FormattingEnabled = formatting,
                UpdateMode = updateMode,
                FormatString = format!,
            };
            return true;
        }

        private static bool TryBindingCall(StatementSyntax st, string ownerId, out ObjectCreationExpressionSyntax? creation)
        {
            creation = null;
            if (st is not ExpressionStatementSyntax { Expression: InvocationExpressionSyntax inv })
                return false;
            if (inv.Expression is not MemberAccessExpressionSyntax ma || ma.Name.Identifier.ValueText != "Add")
                return false;
            var receiver = Flatten(ma.Expression);
            if (receiver.Count != 2 || receiver[0] != ownerId || receiver[1] != "DataBindings")
                return false;
            if (inv.ArgumentList.Arguments.Count == 1
                && inv.ArgumentList.Arguments[0].Expression is ObjectCreationExpressionSyntax oce)
                creation = oce;
            return true;
        }

        private static StatementSyntax BindingStatement(string ownerId, BindingItem item, string indent, string nl)
        {
            var args = new List<string>
            {
                SyntaxFactory.Literal(item.PropertyName).ToString(),
                "this." + item.DataSourceId,
                SyntaxFactory.Literal(item.DataMember).ToString(),
                item.FormattingEnabled ? "true" : "false",
            };
            if (item.UpdateMode != "OnValidation" || item.FormatString.Length > 0)
                args.Add(UpdateModeType + "." + item.UpdateMode);
            if (item.FormatString.Length > 0)
            {
                args.Add("null");
                args.Add(SyntaxFactory.Literal(item.FormatString).ToString());
            }
            string code = "this." + ownerId + ".DataBindings.Add(new " + BindingType + "("
                          + string.Join(", ", args) + "));";
            return SyntaxFactory.ParseStatement(code)
                .WithLeadingTrivia(SyntaxFactory.Whitespace(indent))
                .WithTrailingTrivia(SyntaxFactory.EndOfLine(nl));
        }

        private static Dictionary<string, string> FieldTypes(ClassDeclarationSyntax cls)
        {
            var result = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var part in FormClassResolver.PartialsOf(cls))
            {
                foreach (var field in part.Members.OfType<FieldDeclarationSyntax>())
                {
                    string typeName = field.Declaration.Type.ToString();
                    foreach (var variable in field.Declaration.Variables)
                        result[variable.Identifier.ValueText] = typeName;
                }
            }
            return result;
        }

        private static bool IsBindingSourceType(string typeName)
        {
            string simple = typeName.Replace("global::", "", StringComparison.Ordinal);
            return simple.EndsWith("BindingSource", StringComparison.Ordinal)
                || simple.EndsWith("DataSet", StringComparison.Ordinal)
                || simple.EndsWith("DataTable", StringComparison.Ordinal)
                || simple.EndsWith("DataView", StringComparison.Ordinal)
                || simple.Contains("BindingList", StringComparison.Ordinal)
                || simple.Contains("IList", StringComparison.Ordinal);
        }

        private static bool SupportsDataSource(string typeName)
        {
            string simple = typeName.Replace("global::", "", StringComparison.Ordinal);
            return simple.EndsWith("BindingSource", StringComparison.Ordinal)
                || simple.EndsWith("DataGridView", StringComparison.Ordinal)
                || simple.EndsWith("ComboBox", StringComparison.Ordinal)
                || simple.EndsWith("ListBox", StringComparison.Ordinal)
                || simple.EndsWith("CheckedListBox", StringComparison.Ordinal);
        }

        private static bool IsSafeTypeName(string value)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length > 512)
                return false;
            string text = value.StartsWith("global::", StringComparison.Ordinal) ? value.Substring(8) : value;
            var parts = text.Split('.');
            return parts.Length > 0 && parts.All(IsIdentifier);
        }

        private static bool IsBindingType(TypeSyntax type)
        {
            string text = type.ToString().Replace("global::", "", StringComparison.Ordinal);
            return text == "Binding" || text.EndsWith(".Binding", StringComparison.Ordinal);
        }

        private static bool TryUpdateMode(ExpressionSyntax expression, out string mode)
        {
            mode = "";
            if (expression is not MemberAccessExpressionSyntax ma)
                return false;
            string candidate = ma.Name.Identifier.ValueText;
            if (!UpdateModes.Contains(candidate))
                return false;
            string owner = ma.Expression.ToString().Replace("global::", "", StringComparison.Ordinal);
            if (owner != "DataSourceUpdateMode" && !owner.EndsWith(".DataSourceUpdateMode", StringComparison.Ordinal))
                return false;
            mode = candidate;
            return true;
        }

        private static bool TryFieldReference(ExpressionSyntax expression, out string? id)
        {
            id = null;
            var chain = Flatten(expression);
            if (chain.Count != 1 || !IsIdentifier(chain[0]))
                return false;
            id = chain[0];
            return true;
        }

        private static bool TryStringLiteral(ExpressionSyntax expression, out string? value)
        {
            if (expression is LiteralExpressionSyntax literal && literal.IsKind(SyntaxKind.StringLiteralExpression))
            {
                value = literal.Token.ValueText;
                return true;
            }
            value = null;
            return false;
        }

        private static bool TryBoolLiteral(ExpressionSyntax expression, out bool value)
        {
            if (expression.IsKind(SyntaxKind.TrueLiteralExpression)) { value = true; return true; }
            if (expression.IsKind(SyntaxKind.FalseLiteralExpression)) { value = false; return true; }
            value = false;
            return false;
        }

        private static bool IsOwnerAssignment(StatementSyntax st, string ownerId)
        {
            if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assignment })
                return false;
            var left = Flatten(assignment.Left);
            return left.Count >= 1 && left[0] == ownerId;
        }

        private static List<string> Flatten(ExpressionSyntax expression)
        {
            var names = new List<string>();
            void Walk(ExpressionSyntax node)
            {
                switch (node)
                {
                    case MemberAccessExpressionSyntax member:
                        Walk(member.Expression);
                        names.Add(member.Name.Identifier.ValueText);
                        break;
                    case ThisExpressionSyntax:
                        break;
                    case IdentifierNameSyntax identifier:
                        names.Add(identifier.Identifier.ValueText);
                        break;
                    case ParenthesizedExpressionSyntax parenthesized:
                        Walk(parenthesized.Expression);
                        break;
                    default:
                        names.Add("?" + node.Kind());
                        break;
                }
            }
            Walk(expression);
            return names;
        }

        private static bool HasMeaningfulTrivia(StatementSyntax statement) =>
            statement.GetLeadingTrivia().Concat(statement.GetTrailingTrivia()).Any(t =>
                !t.IsKind(SyntaxKind.WhitespaceTrivia) && !t.IsKind(SyntaxKind.EndOfLineTrivia));

        private static string BodyIndent(MethodDeclarationSyntax init)
        {
            var first = init.Body?.Statements.FirstOrDefault();
            string? whitespace = first?.GetLeadingTrivia()
                .FirstOrDefault(t => t.IsKind(SyntaxKind.WhitespaceTrivia)).ToString();
            if (!string.IsNullOrEmpty(whitespace))
                return whitespace;
            string methodIndent = init.GetLeadingTrivia()
                .FirstOrDefault(t => t.IsKind(SyntaxKind.WhitespaceTrivia)).ToString();
            return methodIndent + "    ";
        }

        private static bool IsIdentifier(string value) =>
            !string.IsNullOrEmpty(value) && SyntaxFacts.IsValidIdentifier(value);

        private static BindingItemsResult FailedList(string reason) =>
            new() { Ok = false, Reason = reason };

        private static DataSourceResult FailedDataSource(string reason) =>
            new() { Ok = false, Reason = reason };

        private static EditResult FailedEdit(string reason) =>
            new() { Mode = EditMode.Failed, Reason = reason };
    }
}
