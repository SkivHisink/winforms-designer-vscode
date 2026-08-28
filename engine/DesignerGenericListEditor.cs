using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Windows.Forms;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    public sealed class DesignerGenericListItemsResult
    {
        public bool Ok { get; init; }
        public List<string> Items { get; init; } = new();
        public string ItemTypeName { get; init; } = "";
        public string Reason { get; init; } = "";
    }

    public sealed class DesignerGenericListEditResult
    {
        public EditMode Mode { get; init; } = EditMode.Failed;
        public string? NewText { get; init; }
        public bool ParseOk { get; init; }
        public bool Minimal { get; init; }
        public string Reason { get; init; } = "";
        public bool Safe => NewText != null && Mode != EditMode.Failed && ParseOk && Minimal;
    }

    /// <summary>
    /// Source-first adapter for canonical WinForms designer collection calls:
    /// <c>this.owner.Property.Add(value)</c> and
    /// <c>this.owner.Property.AddRange(new T[] { value, ... })</c>.
    /// The adapter never executes user code. It accepts only exact owner/property identifiers, exact
    /// item type names from local allowlists, bounded invariant item strings, and source expressions that
    /// can be translated back by this same adapter.
    /// </summary>
    public static class DesignerGenericListEditor
    {
        public const int MaxSourceChars = 2_000_000;
        public const int MaxItems = 512;
        public const int MaxItemChars = 4096;
        public const int MaxIdentifierChars = 128;
        public const int MaxTypeNameChars = 256;
        public const int MaxExpressionChars = 8192;

        private enum ItemKind
        {
            String,
            Boolean,
            Char,
            SByte,
            Byte,
            Int16,
            UInt16,
            Int32,
            UInt32,
            Int64,
            UInt64,
            Single,
            Double,
            Decimal,
            Enum,
            Complex,
        }

        private sealed class ItemTypeSpec
        {
            public ItemKind Kind { get; init; }
            public string CanonicalName { get; init; } = "";
            public string CSharpTypeName { get; init; } = "";
            public Type? EnumType { get; init; }
        }

        private sealed class TargetCall
        {
            public ExpressionStatementSyntax Statement { get; init; } = null!;
            public InvocationExpressionSyntax Invocation { get; init; } = null!;
            public string Method { get; init; } = "";
        }

        private static readonly Dictionary<string, ItemTypeSpec> ScalarTypes = BuildScalarTypes();

        private static readonly Dictionary<string, ItemTypeSpec> EnumTypes = BuildEnumTypes(
            typeof(AnchorStyles),
            typeof(DockStyle),
            typeof(CheckState),
            typeof(DialogResult),
            typeof(FormBorderStyle),
            typeof(ComboBoxStyle),
            typeof(FlatStyle),
            typeof(ScrollBars),
            typeof(BorderStyle),
            typeof(Orientation),
            typeof(HorizontalAlignment),
            typeof(DataGridViewContentAlignment),
            typeof(Keys),
            typeof(FontStyle),
            typeof(GraphicsUnit),
            typeof(ContentAlignment),
            typeof(System.Drawing.Drawing2D.DashStyle));

        private static readonly HashSet<string> ComplexTypeNames = new(StringComparer.Ordinal)
        {
            "System.Drawing.Point",
            "System.Drawing.Size",
            "System.Drawing.Color",
            "System.Drawing.Rectangle",
            "System.Windows.Forms.Padding",
            "System.Drawing.Font",
            "System.Windows.Forms.Cursor",
        };

        /// <summary>Metadata-side capability probe used by <c>DesignerDescribe</c>. The same exact allowlist and
        /// canonical-name resolver gates the read/write adapter, so the property grid cannot advertise a collection
        /// type that the source-first editor would later reject.</summary>
        public static bool SupportsItemType(string itemTypeName) =>
            !string.IsNullOrWhiteSpace(itemTypeName) && TryResolveItemType(itemTypeName, out _);

        /// <summary>Shared broker/worker gate for a bounded invariant item payload. Every item must be accepted by
        /// the same expression builder used by the source-first collection writer.</summary>
        public static bool AreItemsSupported(string itemTypeName, IReadOnlyList<string> items)
        {
            if (!TryResolveItemType(itemTypeName, out var spec) || !TryValidateItems(items, out _)) return false;
            foreach (string item in items)
                if (!TryBuildItemExpression(spec, item, out _, out _)) return false;
            return true;
        }

        public static DesignerGenericListItemsResult ListItems(
            string sourceText,
            string ownerId,
            string propertyName,
            string itemTypeName)
        {
            if (!TryValidateRequest(sourceText, ownerId, propertyName, itemTypeName, out var spec, out var reason))
                return ListFailed(itemTypeName, reason);

            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            if (HasParseErrors(root)) return ListFailed(spec.CanonicalName, "source has syntax errors");

            var init = FormClassResolver.InitMethod(root);
            if (init?.Body == null) return ListFailed(spec.CanonicalName, "InitializeComponent not found");

            var items = new List<string>();
            foreach (var st in init.Body.Statements)
            {
                if (!TryGetTargetCall(st, ownerId, propertyName, out var call)) continue;

                if (call.Method == "Add")
                {
                    var args = call.Invocation.ArgumentList.Arguments;
                    if (args.Count != 1)
                        return ListFailed(spec.CanonicalName, "unexpected Add shape in " + ownerId + "." + propertyName);
                    if (!TryReadItemInvariant(spec, args[0].Expression, out var value, out reason))
                        return ListFailed(spec.CanonicalName, reason);
                    items.Add(value);
                    continue;
                }

                var rangeArgs = call.Invocation.ArgumentList.Arguments;
                if (rangeArgs.Count != 1)
                    return ListFailed(spec.CanonicalName, "unexpected AddRange shape in " + ownerId + "." + propertyName);
                if (!TryGetArrayElements(rangeArgs[0].Expression, spec, allowObjectArray: true, out var elements, out reason))
                    return ListFailed(spec.CanonicalName, reason);

                foreach (var element in elements)
                {
                    if (!TryReadItemInvariant(spec, element, out var value, out reason))
                        return ListFailed(spec.CanonicalName, reason);
                    items.Add(value);
                }
            }

            return new DesignerGenericListItemsResult
            {
                Ok = true,
                ItemTypeName = spec.CanonicalName,
                Items = items,
            };
        }

        public static DesignerGenericListEditResult SetItems(
            string sourceText,
            string ownerId,
            string propertyName,
            string itemTypeName,
            IReadOnlyList<string> items)
        {
            if (!TryValidateRequest(sourceText, ownerId, propertyName, itemTypeName, out var spec, out var reason))
                return EditFailed(reason);
            if (!TryValidateItems(items, out reason)) return EditFailed(reason);

            var expressions = new List<string>(items.Count);
            foreach (string item in items)
            {
                if (!TryBuildItemExpression(spec, item, out var expression, out reason))
                    return EditFailed(reason);
                expressions.Add(expression);
            }

            var root = CSharpSyntaxTree.ParseText(sourceText).GetRoot();
            if (HasParseErrors(root)) return EditFailed("source has syntax errors");

            var init = FormClassResolver.InitMethod(root);
            if (init?.Body == null) return EditFailed("InitializeComponent not found");

            var targets = init.Body.Statements
                .Select(st => TryGetTargetCall(st, ownerId, propertyName, out var call) ? call : null)
                .Where(call => call != null)
                .Cast<TargetCall>()
                .ToList();

            if (targets.Count == 0 && expressions.Count == 0)
            {
                return new DesignerGenericListEditResult
                {
                    Mode = EditMode.Replace,
                    NewText = sourceText,
                    ParseOk = true,
                    Minimal = true,
                };
            }

            string edited;
            EditMode mode;
            if (targets.Count > 0)
            {
                var first = targets[0].Statement;
                // Preserve AddRange only when the source already proves that this concrete collection exposes it.
                // IList<T> itself has Add(T), not AddRange; advertising an IList<T> property and inventing AddRange
                // would pass syntax/minimality checks yet leave the designer source semantically uncompilable.
                var replacements = expressions.Count == 0
                    ? new List<ExpressionStatementSyntax>()
                    : targets.Any(t => t.Method == "AddRange")
                        ? [BuildAddRange(ownerId, propertyName, PreferredArrayElementType(targets, spec), expressions)]
                        : expressions.Select(expression => BuildAdd(ownerId, propertyName, expression)).ToList();

                var newStatements = new List<StatementSyntax>();
                foreach (var statement in init.Body.Statements)
                {
                    if (ReferenceEquals(statement, first))
                    {
                        for (int i = 0; i < replacements.Count; i++)
                        {
                            var replacement = replacements[i]
                                .WithLeadingTrivia(i == 0
                                    ? statement.GetLeadingTrivia()
                                    : SyntaxFactory.TriviaList(SyntaxFactory.Whitespace(LineIndent(statement))))
                                .WithTrailingTrivia(i == replacements.Count - 1
                                    ? statement.GetTrailingTrivia()
                                    : SyntaxFactory.TriviaList(SyntaxFactory.EndOfLine(LineEnding(sourceText))));
                            newStatements.Add(replacement);
                        }
                    }
                    else if (targets.Any(t => ReferenceEquals(t.Statement, statement)))
                    {
                        continue;
                    }
                    else
                    {
                        newStatements.Add(statement);
                    }
                }

                var newInit = init.WithBody(init.Body.WithStatements(SyntaxFactory.List(newStatements)));
                edited = root.ReplaceNode(init, newInit).ToFullString();
                mode = EditMode.Replace;
            }
            else
            {
                var anchor = init.Body.Statements.LastOrDefault(st => TargetsOwner(st, ownerId))
                          ?? init.Body.Statements.LastOrDefault(st => MentionsIdentifier(st, ownerId));
                if (anchor == null)
                    return EditFailed("no statement references " + ownerId + " to anchor the new collection items");

                var statements = expressions.Select(expression =>
                    (StatementSyntax)BuildAdd(ownerId, propertyName, expression)
                        .WithLeadingTrivia(SyntaxFactory.Whitespace(LineIndent(anchor)))
                        .WithTrailingTrivia(SyntaxFactory.EndOfLine(LineEnding(sourceText))));
                edited = root.InsertNodesAfter(anchor, statements).ToFullString();
                mode = EditMode.Insert;
            }

            bool parseOk = !CSharpSyntaxTree.ParseText(edited).GetDiagnostics()
                .Any(d => d.Severity == DiagnosticSeverity.Error);
            bool minimal = parseOk && OnlyGenericListChanged(sourceText, edited, ownerId, propertyName, itemTypeName);
            bool roundTrip = false;
            if (minimal)
            {
                var listed = ListItems(edited, ownerId, propertyName, itemTypeName);
                roundTrip = listed.Ok && listed.Items.SequenceEqual(items, StringComparer.Ordinal);
            }

            if (!parseOk || !minimal || !roundTrip)
            {
                return new DesignerGenericListEditResult
                {
                    Mode = EditMode.Failed,
                    ParseOk = parseOk,
                    Minimal = minimal,
                    Reason = !parseOk
                        ? "edited source has syntax errors"
                        : (!minimal ? "edit changed non-target source or emitted an unsupported expression" : "edited source did not round-trip requested items"),
                };
            }

            return new DesignerGenericListEditResult
            {
                Mode = mode,
                NewText = edited,
                ParseOk = true,
                Minimal = true,
            };
        }

        public static bool OnlyGenericListChanged(
            string original,
            string edited,
            string ownerId,
            string propertyName,
            string itemTypeName)
        {
            if (!TryValidateRequest(original, ownerId, propertyName, itemTypeName, out var spec, out _)) return false;
            if (edited == null || edited.Length > MaxSourceChars) return false;

            var editedRoot = CSharpSyntaxTree.ParseText(edited).GetRoot();
            if (HasParseErrors(editedRoot)) return false;

            var originalClass = Classify(original, ownerId, propertyName);
            var editedClass = Classify(edited, ownerId, propertyName);
            if (!originalClass.ok || !editedClass.ok) return false;
            if (!originalClass.nonTargets.SequenceEqual(editedClass.nonTargets, StringComparer.Ordinal)) return false;
            if (!CommentAndDirectiveTrivia(original).SequenceEqual(CommentAndDirectiveTrivia(edited), StringComparer.Ordinal))
                return false;

            foreach (var target in editedClass.targets)
            {
                if (!TargetCallContainsOnlyAdapterExpressions(target, spec)) return false;
            }

            return true;
        }

        private static DesignerGenericListItemsResult ListFailed(string itemTypeName, string reason) => new()
        {
            ItemTypeName = itemTypeName,
            Reason = reason,
        };

        private static DesignerGenericListEditResult EditFailed(string reason) => new()
        {
            Mode = EditMode.Failed,
            Reason = reason,
        };

        private static bool TryValidateRequest(
            string sourceText,
            string ownerId,
            string propertyName,
            string itemTypeName,
            out ItemTypeSpec spec,
            out string reason)
        {
            spec = null!;
            reason = "";
            if (sourceText == null) { reason = "source is required"; return false; }
            if (sourceText.Length > MaxSourceChars) { reason = "source exceeds " + MaxSourceChars.ToString(CultureInfo.InvariantCulture) + " characters"; return false; }
            if (!IsIdentifier(ownerId)) { reason = "invalid owner id: " + ownerId; return false; }
            if (!IsIdentifier(propertyName)) { reason = "invalid property name: " + propertyName; return false; }
            if (string.IsNullOrWhiteSpace(itemTypeName) || itemTypeName.Length > MaxTypeNameChars)
            {
                reason = "invalid item type name";
                return false;
            }
            if (!TryResolveItemType(itemTypeName, out spec))
            {
                reason = "unsupported item type: " + itemTypeName;
                return false;
            }
            return true;
        }

        private static bool TryValidateItems(IReadOnlyList<string> items, out string reason)
        {
            reason = "";
            if (items == null) { reason = "items are required"; return false; }
            if (items.Count > MaxItems)
            {
                reason = "item count exceeds " + MaxItems.ToString(CultureInfo.InvariantCulture);
                return false;
            }
            for (int i = 0; i < items.Count; i++)
            {
                if (items[i] == null) { reason = "item " + i.ToString(CultureInfo.InvariantCulture) + " is null"; return false; }
                if (items[i].Length > MaxItemChars)
                {
                    reason = "item " + i.ToString(CultureInfo.InvariantCulture) + " exceeds " + MaxItemChars.ToString(CultureInfo.InvariantCulture) + " characters";
                    return false;
                }
            }
            return true;
        }

        private static bool TryResolveItemType(string itemTypeName, out ItemTypeSpec spec)
        {
            if (ScalarTypes.TryGetValue(itemTypeName, out spec!)) return true;
            if (EnumTypes.TryGetValue(itemTypeName, out spec!)) return true;
            if (ComplexTypeNames.Contains(itemTypeName))
            {
                spec = new ItemTypeSpec
                {
                    Kind = ItemKind.Complex,
                    CanonicalName = itemTypeName,
                    CSharpTypeName = itemTypeName,
                };
                return true;
            }
            spec = null!;
            return false;
        }

        private static bool TryBuildItemExpression(ItemTypeSpec spec, string invariant, out string expression, out string reason)
        {
            expression = "";
            reason = "";
            try
            {
                switch (spec.Kind)
                {
                    case ItemKind.String:
                        expression = SyntaxFactory.Literal(invariant).ToString();
                        return true;
                    case ItemKind.Boolean:
                        if (!bool.TryParse(invariant, out var b)) break;
                        expression = b ? "true" : "false";
                        return true;
                    case ItemKind.Char:
                        if (invariant.Length != 1) break;
                        expression = SyntaxFactory.Literal(invariant[0]).ToString();
                        return true;
                    case ItemKind.SByte:
                        if (!sbyte.TryParse(invariant, NumberStyles.Integer, CultureInfo.InvariantCulture, out var sb)) break;
                        expression = SyntaxFactory.Literal(sb).ToString();
                        return true;
                    case ItemKind.Byte:
                        if (!byte.TryParse(invariant, NumberStyles.Integer, CultureInfo.InvariantCulture, out var by)) break;
                        expression = SyntaxFactory.Literal(by).ToString();
                        return true;
                    case ItemKind.Int16:
                        if (!short.TryParse(invariant, NumberStyles.Integer, CultureInfo.InvariantCulture, out var sh)) break;
                        expression = SyntaxFactory.Literal(sh).ToString();
                        return true;
                    case ItemKind.UInt16:
                        if (!ushort.TryParse(invariant, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ush)) break;
                        expression = SyntaxFactory.Literal(ush).ToString();
                        return true;
                    case ItemKind.Int32:
                        if (!int.TryParse(invariant, NumberStyles.Integer, CultureInfo.InvariantCulture, out var i)) break;
                        expression = SyntaxFactory.Literal(i).ToString();
                        return true;
                    case ItemKind.UInt32:
                        if (!uint.TryParse(invariant, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ui)) break;
                        expression = SyntaxFactory.Literal(ui).ToString();
                        return true;
                    case ItemKind.Int64:
                        if (!long.TryParse(invariant, NumberStyles.Integer, CultureInfo.InvariantCulture, out var l)) break;
                        expression = SyntaxFactory.Literal(l).ToString();
                        return true;
                    case ItemKind.UInt64:
                        if (!ulong.TryParse(invariant, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ul)) break;
                        expression = SyntaxFactory.Literal(ul).ToString();
                        return true;
                    case ItemKind.Single:
                        if (!float.TryParse(invariant, NumberStyles.Float, CultureInfo.InvariantCulture, out var f) || float.IsNaN(f) || float.IsInfinity(f)) break;
                        expression = SyntaxFactory.Literal(f).ToString();
                        return true;
                    case ItemKind.Double:
                        if (!double.TryParse(invariant, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) || double.IsNaN(d) || double.IsInfinity(d)) break;
                        expression = SyntaxFactory.Literal(d).ToString();
                        return true;
                    case ItemKind.Decimal:
                        if (!decimal.TryParse(invariant, NumberStyles.Float, CultureInfo.InvariantCulture, out var dec)) break;
                        expression = SyntaxFactory.Literal(dec).ToString();
                        return true;
                    case ItemKind.Enum:
                        return TryBuildEnumExpression(spec, invariant, out expression, out reason);
                    case ItemKind.Complex:
                        expression = DesignerValueConverter.ToExpression(spec.CanonicalName, invariant) ?? "";
                        if (expression.Length == 0 || expression.Length > MaxExpressionChars) break;
                        if (!IsSingleExpression(expression)) break;
                        if (!TryReadItemInvariant(spec, SyntaxFactory.ParseExpression(expression), out var readBack, out _)) break;
                        if (!string.Equals(readBack, invariant, StringComparison.Ordinal)) break;
                        return true;
                }
            }
            catch
            {
                reason = "invalid item value for " + spec.CanonicalName + ": " + invariant;
                return false;
            }

            reason = "invalid item value for " + spec.CanonicalName + ": " + invariant;
            return false;
        }

        private static bool TryReadItemInvariant(ItemTypeSpec spec, ExpressionSyntax expression, out string value, out string reason)
        {
            value = "";
            reason = "";
            switch (spec.Kind)
            {
                case ItemKind.String:
                    if (expression is LiteralExpressionSyntax stringLit && stringLit.IsKind(SyntaxKind.StringLiteralExpression))
                    {
                        value = stringLit.Token.ValueText;
                        return true;
                    }
                    break;
                case ItemKind.Boolean:
                    if (expression.IsKind(SyntaxKind.TrueLiteralExpression) || expression.IsKind(SyntaxKind.FalseLiteralExpression))
                    {
                        value = expression.IsKind(SyntaxKind.TrueLiteralExpression) ? "True" : "False";
                        return true;
                    }
                    break;
                case ItemKind.Char:
                    if (expression is LiteralExpressionSyntax charLit && charLit.IsKind(SyntaxKind.CharacterLiteralExpression))
                    {
                        value = charLit.Token.ValueText;
                        return true;
                    }
                    break;
                case ItemKind.SByte:
                    return TryReadIntegral(expression, sbyte.MinValue, sbyte.MaxValue, out value, out reason);
                case ItemKind.Byte:
                    return TryReadIntegral(expression, byte.MinValue, byte.MaxValue, out value, out reason);
                case ItemKind.Int16:
                    return TryReadIntegral(expression, short.MinValue, short.MaxValue, out value, out reason);
                case ItemKind.UInt16:
                    return TryReadIntegral(expression, ushort.MinValue, ushort.MaxValue, out value, out reason);
                case ItemKind.Int32:
                    return TryReadIntegral(expression, int.MinValue, int.MaxValue, out value, out reason);
                case ItemKind.UInt32:
                    return TryReadIntegral(expression, uint.MinValue, uint.MaxValue, out value, out reason);
                case ItemKind.Int64:
                    return TryReadIntegral(expression, long.MinValue, long.MaxValue, out value, out reason);
                case ItemKind.UInt64:
                    return TryReadUnsignedIntegral(expression, ulong.MaxValue, out value, out reason);
                case ItemKind.Single:
                    return TryReadFloating(expression, isSingle: true, out value, out reason);
                case ItemKind.Double:
                    return TryReadFloating(expression, isSingle: false, out value, out reason);
                case ItemKind.Decimal:
                    return TryReadDecimal(expression, out value, out reason);
                case ItemKind.Enum:
                    return TryReadEnumInvariant(spec, expression, out value, out reason);
                case ItemKind.Complex:
                    string? complex = DesignerValueConverter.FromExpression(spec.CanonicalName, expression.ToString());
                    if (complex != null)
                    {
                        value = complex;
                        return true;
                    }
                    if (TryReadConverterComplexInvariant(spec.CanonicalName, expression, out complex))
                    {
                        value = complex;
                        return true;
                    }
                    break;
            }

            reason = "unsupported " + spec.CanonicalName + " expression: " + expression;
            return false;
        }

        private static bool TryReadConverterComplexInvariant(string typeName, ExpressionSyntax expression, out string invariant)
        {
            invariant = "";
            if (!TryEvalConverterComplexValue(typeName, expression, out var value) || value == null) return false;
            var converter = TypeDescriptor.GetConverter(value.GetType());
            if (converter == null || !converter.CanConvertTo(typeof(string))) return false;
            string? converted = converter.ConvertToInvariantString(value);
            if (converted == null) return false;
            invariant = converted;
            return true;
        }

        private static bool TryEvalConverterComplexValue(string typeName, ExpressionSyntax expression, out object? value)
        {
            value = null;
            if (expression is ParenthesizedExpressionSyntax p)
                return TryEvalConverterComplexValue(typeName, p.Expression, out value);

            if (typeName == "System.Windows.Forms.Cursor" && expression is MemberAccessExpressionSyntax cursorAccess)
            {
                string owner = cursorAccess.Expression.ToString();
                if (owner != "System.Windows.Forms.Cursors" && owner != "Cursors") return false;
                var property = typeof(Cursors).GetProperty(cursorAccess.Name.Identifier.ValueText);
                if (property == null || property.PropertyType != typeof(Cursor)) return false;
                value = property.GetValue(null);
                return value != null;
            }

            if (expression is not ObjectCreationExpressionSyntax objectCreation || objectCreation.ArgumentList == null)
                return false;
            if (objectCreation.Type.ToString() != typeName && objectCreation.Type.ToString() != typeName.Split('.').Last())
                return false;

            var args = objectCreation.ArgumentList.Arguments.Select(a => a.Expression).ToList();
            if (!args.All(a => TryNumericLiteral(a, out _, out _))) return false;

            bool Arg(int index, out int number)
            {
                number = 0;
                if (!TryNumericLiteral(args[index], out var raw, out _)) return false;
                try
                {
                    number = Convert.ToInt32(raw, CultureInfo.InvariantCulture);
                    return true;
                }
                catch
                {
                    return false;
                }
            }

            switch (typeName)
            {
                case "System.Drawing.Point" when args.Count == 2 && Arg(0, out var x) && Arg(1, out var y):
                    value = new Point(x, y);
                    return true;
                case "System.Drawing.Size" when args.Count == 2 && Arg(0, out var width) && Arg(1, out var height):
                    value = new Size(width, height);
                    return true;
                case "System.Drawing.Rectangle" when args.Count == 4 &&
                    Arg(0, out var x) && Arg(1, out var y) && Arg(2, out var width) && Arg(3, out var height):
                    value = new Rectangle(x, y, width, height);
                    return true;
                case "System.Windows.Forms.Padding" when args.Count == 1 && Arg(0, out var all):
                    value = new Padding(all);
                    return true;
                case "System.Windows.Forms.Padding" when args.Count == 4 &&
                    Arg(0, out var left) && Arg(1, out var top) && Arg(2, out var right) && Arg(3, out var bottom):
                    value = new Padding(left, top, right, bottom);
                    return true;
                default:
                    return false;
            }
        }

        private static bool TryBuildEnumExpression(ItemTypeSpec spec, string invariant, out string expression, out string reason)
        {
            expression = "";
            reason = "";
            Type enumType = spec.EnumType!;
            var names = invariant.Split(new[] { ',', '|' }, StringSplitOptions.RemoveEmptyEntries)
                .Select(p => p.Trim())
                .Where(p => p.Length > 0)
                .ToList();
            if (names.Count == 0)
            {
                reason = "enum value is empty";
                return false;
            }

            bool flags = enumType.GetCustomAttributes(typeof(FlagsAttribute), inherit: false).Length > 0;
            if (!flags && names.Count != 1)
            {
                reason = spec.CanonicalName + " is not a flags enum";
                return false;
            }

            var normalized = new List<string>();
            foreach (string name in names)
            {
                string? actual = Enum.GetNames(enumType).FirstOrDefault(n => string.Equals(n, name, StringComparison.Ordinal));
                if (actual == null)
                {
                    reason = "unsupported enum member " + spec.CanonicalName + "." + name;
                    return false;
                }
                normalized.Add(spec.CanonicalName + "." + actual);
            }

            expression = string.Join(" | ", normalized);
            return true;
        }

        private static bool TryReadEnumInvariant(ItemTypeSpec spec, ExpressionSyntax expression, out string value, out string reason)
        {
            value = "";
            reason = "";
            if (!TryEvalEnum(spec, expression, out long numeric, out reason)) return false;
            object enumValue = Enum.ToObject(spec.EnumType!, numeric);
            value = enumValue.ToString() ?? "";
            if (value.Length == 0 || value.Any(char.IsDigit))
            {
                reason = "unsupported unnamed enum value for " + spec.CanonicalName;
                return false;
            }
            return true;
        }

        private static bool TryEvalEnum(ItemTypeSpec spec, ExpressionSyntax expression, out long value, out string reason)
        {
            value = 0;
            reason = "";
            if (expression is ParenthesizedExpressionSyntax p)
                return TryEvalEnum(spec, p.Expression, out value, out reason);

            if (expression is BinaryExpressionSyntax be && be.IsKind(SyntaxKind.BitwiseOrExpression))
            {
                if (!TryEvalEnum(spec, be.Left, out var left, out reason)) return false;
                if (!TryEvalEnum(spec, be.Right, out var right, out reason)) return false;
                value = left | right;
                return true;
            }

            if (expression is MemberAccessExpressionSyntax ma)
            {
                if (!ExpressionNamesType(ma.Expression, spec)) goto unsupported;
                string member = ma.Name.Identifier.ValueText;
                if (!Enum.GetNames(spec.EnumType!).Contains(member, StringComparer.Ordinal))
                {
                    reason = "unsupported enum member " + spec.CanonicalName + "." + member;
                    return false;
                }
                value = Convert.ToInt64(Enum.Parse(spec.EnumType!, member), CultureInfo.InvariantCulture);
                return true;
            }

        unsupported:
            reason = "unsupported enum expression: " + expression;
            return false;
        }

        private static bool ExpressionNamesType(ExpressionSyntax expression, ItemTypeSpec spec)
        {
            string text = expression.ToString();
            if (string.Equals(text, spec.CanonicalName, StringComparison.Ordinal)) return true;
            if (spec.EnumType != null && string.Equals(text, spec.EnumType.Name, StringComparison.Ordinal)) return true;
            return false;
        }

        private static bool TryReadIntegral(ExpressionSyntax expression, long min, long max, out string value, out string reason)
        {
            value = "";
            if (!TryNumericLiteral(expression, out var raw, out reason)) return false;
            try
            {
                long converted = Convert.ToInt64(raw, CultureInfo.InvariantCulture);
                if (converted < min || converted > max)
                {
                    reason = "integer literal out of range";
                    return false;
                }
                value = converted.ToString(CultureInfo.InvariantCulture);
                return true;
            }
            catch
            {
                reason = "unsupported integer literal: " + expression;
                return false;
            }
        }

        private static bool TryReadUnsignedIntegral(ExpressionSyntax expression, ulong max, out string value, out string reason)
        {
            value = "";
            if (!TryNumericLiteral(expression, out var raw, out reason)) return false;
            try
            {
                ulong converted = Convert.ToUInt64(raw, CultureInfo.InvariantCulture);
                if (converted > max)
                {
                    reason = "unsigned integer literal out of range";
                    return false;
                }
                value = converted.ToString(CultureInfo.InvariantCulture);
                return true;
            }
            catch
            {
                reason = "unsupported unsigned integer literal: " + expression;
                return false;
            }
        }

        private static bool TryReadFloating(ExpressionSyntax expression, bool isSingle, out string value, out string reason)
        {
            value = "";
            if (!TryNumericLiteral(expression, out var raw, out reason)) return false;
            try
            {
                if (isSingle)
                {
                    float f = Convert.ToSingle(raw, CultureInfo.InvariantCulture);
                    if (float.IsNaN(f) || float.IsInfinity(f))
                    {
                        reason = "non-finite float literal";
                        return false;
                    }
                    value = f.ToString("R", CultureInfo.InvariantCulture);
                    return true;
                }

                double d = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
                if (double.IsNaN(d) || double.IsInfinity(d))
                {
                    reason = "non-finite double literal";
                    return false;
                }
                value = d.ToString("R", CultureInfo.InvariantCulture);
                return true;
            }
            catch
            {
                reason = "unsupported floating literal: " + expression;
                return false;
            }
        }

        private static bool TryReadDecimal(ExpressionSyntax expression, out string value, out string reason)
        {
            value = "";
            if (!TryNumericLiteral(expression, out var raw, out reason)) return false;
            try
            {
                decimal d = Convert.ToDecimal(raw, CultureInfo.InvariantCulture);
                value = d.ToString("G29", CultureInfo.InvariantCulture);
                return true;
            }
            catch
            {
                reason = "unsupported decimal literal: " + expression;
                return false;
            }
        }

        private static bool TryNumericLiteral(ExpressionSyntax expression, out object raw, out string reason)
        {
            reason = "";
            raw = 0;
            if (expression is ParenthesizedExpressionSyntax p)
                return TryNumericLiteral(p.Expression, out raw, out reason);

            if (expression is PrefixUnaryExpressionSyntax u && u.IsKind(SyntaxKind.UnaryMinusExpression))
            {
                if (!TryNumericLiteral(u.Operand, out var positive, out reason)) return false;
                if (positive is ulong tooLarge)
                {
                    if (tooLarge > long.MaxValue)
                    {
                        reason = "negative unsigned literal out of range";
                        return false;
                    }
                    raw = -(long)tooLarge;
                    return true;
                }
                raw = positive switch
                {
                    sbyte v => -v,
                    short v => -v,
                    int v => -v,
                    long v => -v,
                    float v => -v,
                    double v => -v,
                    decimal v => -v,
                    byte v => -v,
                    ushort v => -v,
                    uint v => -(long)v,
                    _ => positive,
                };
                return true;
            }

            if (expression is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.NumericLiteralExpression))
            {
                raw = lit.Token.Value!;
                return true;
            }

            reason = "unsupported numeric expression: " + expression;
            return false;
        }

        private static bool TryGetArrayElements(
            ExpressionSyntax expression,
            ItemTypeSpec spec,
            bool allowObjectArray,
            out IReadOnlyList<ExpressionSyntax> elements,
            out string reason)
        {
            elements = Array.Empty<ExpressionSyntax>();
            reason = "";
            switch (expression)
            {
                case ArrayCreationExpressionSyntax ac when ac.Initializer != null:
                    string elementType = ArrayElementTypeName(ac.Type);
                    if (!ArrayElementTypeMatches(elementType, spec, allowObjectArray))
                    {
                        reason = "unexpected AddRange array type " + elementType + " for " + spec.CanonicalName;
                        return false;
                    }
                    elements = ac.Initializer.Expressions.ToList();
                    return true;
                case ImplicitArrayCreationExpressionSyntax iac:
                    elements = iac.Initializer.Expressions.ToList();
                    return true;
                default:
                    reason = "unexpected AddRange shape for " + spec.CanonicalName;
                    return false;
            }
        }

        private static bool TryGetTargetCall(StatementSyntax statement, string ownerId, string propertyName, out TargetCall call)
        {
            call = null!;
            if (statement is not ExpressionStatementSyntax expressionStatement ||
                expressionStatement.Expression is not InvocationExpressionSyntax invocation ||
                invocation.Expression is not MemberAccessExpressionSyntax memberAccess)
            {
                return false;
            }

            string method = memberAccess.Name.Identifier.ValueText;
            if (method != "Add" && method != "AddRange") return false;

            var chain = Flatten(memberAccess.Expression);
            if (chain.Count != 2 || chain[0] != ownerId || chain[1] != propertyName) return false;

            call = new TargetCall
            {
                Statement = expressionStatement,
                Invocation = invocation,
                Method = method,
            };
            return true;
        }

        private static bool TargetCallContainsOnlyAdapterExpressions(TargetCall target, ItemTypeSpec spec)
        {
            if (target.Method == "Add")
            {
                var args = target.Invocation.ArgumentList.Arguments;
                return args.Count == 1 && TryReadItemInvariant(spec, args[0].Expression, out _, out _);
            }

            var rangeArgs = target.Invocation.ArgumentList.Arguments;
            if (rangeArgs.Count != 1) return false;
            if (!TryGetArrayElements(rangeArgs[0].Expression, spec, allowObjectArray: true, out var elements, out _))
                return false;
            foreach (var element in elements)
            {
                if (!TryReadItemInvariant(spec, element, out _, out _)) return false;
            }
            return true;
        }

        private static ExpressionStatementSyntax BuildAddRange(
            string ownerId,
            string propertyName,
            string arrayElementTypeName,
            IReadOnlyList<string> expressions)
        {
            var sb = new StringBuilder();
            sb.Append("this.")
                .Append(ownerId)
                .Append('.')
                .Append(propertyName)
                .Append(".AddRange(new ")
                .Append(arrayElementTypeName)
                .Append("[] { ");
            sb.Append(string.Join(", ", expressions));
            sb.Append(" });");
            return (ExpressionStatementSyntax)SyntaxFactory.ParseStatement(sb.ToString());
        }

        private static ExpressionStatementSyntax BuildAdd(string ownerId, string propertyName, string expression) =>
            (ExpressionStatementSyntax)SyntaxFactory.ParseStatement(
                "this." + ownerId + "." + propertyName + ".Add(" + expression + ");");

        private static string LineEnding(string source) =>
            source.Contains("\r\n", StringComparison.Ordinal) ? "\r\n"
                : source.Contains('\n') ? "\n"
                : Environment.NewLine;

        private static string PreferredArrayElementType(IReadOnlyList<TargetCall> targets, ItemTypeSpec spec)
        {
            foreach (var target in targets)
            {
                if (target.Method != "AddRange") continue;
                var args = target.Invocation.ArgumentList.Arguments;
                if (args.Count != 1 || args[0].Expression is not ArrayCreationExpressionSyntax ac) continue;
                string elementType = ArrayElementTypeName(ac.Type);
                if (ArrayElementTypeMatches(elementType, spec, allowObjectArray: true))
                    return IsObjectType(elementType) ? "object" : spec.CSharpTypeName;
            }
            return spec.CSharpTypeName;
        }

        private static string ArrayElementTypeName(ArrayTypeSyntax arrayType)
        {
            if (arrayType.RankSpecifiers.Count != 1) return "";
            var rank = arrayType.RankSpecifiers[0];
            if (rank.Sizes.Count != 1 || !rank.Sizes[0].IsKind(SyntaxKind.OmittedArraySizeExpression)) return "";
            return NormalizeTypeSyntax(arrayType.ElementType);
        }

        private static string NormalizeTypeSyntax(TypeSyntax type) =>
            type switch
            {
                PredefinedTypeSyntax p => p.Keyword.Kind() switch
                {
                    SyntaxKind.StringKeyword => "System.String",
                    SyntaxKind.BoolKeyword => "System.Boolean",
                    SyntaxKind.CharKeyword => "System.Char",
                    SyntaxKind.SByteKeyword => "System.SByte",
                    SyntaxKind.ByteKeyword => "System.Byte",
                    SyntaxKind.ShortKeyword => "System.Int16",
                    SyntaxKind.UShortKeyword => "System.UInt16",
                    SyntaxKind.IntKeyword => "System.Int32",
                    SyntaxKind.UIntKeyword => "System.UInt32",
                    SyntaxKind.LongKeyword => "System.Int64",
                    SyntaxKind.ULongKeyword => "System.UInt64",
                    SyntaxKind.FloatKeyword => "System.Single",
                    SyntaxKind.DoubleKeyword => "System.Double",
                    SyntaxKind.DecimalKeyword => "System.Decimal",
                    SyntaxKind.ObjectKeyword => "System.Object",
                    _ => type.ToString(),
                },
                _ => type.ToString(),
            };

        private static bool ArrayElementTypeMatches(string elementType, ItemTypeSpec spec, bool allowObjectArray)
        {
            if (string.Equals(elementType, spec.CanonicalName, StringComparison.Ordinal)) return true;
            if (ScalarTypes.TryGetValue(elementType, out var aliasSpec) &&
                string.Equals(aliasSpec.CanonicalName, spec.CanonicalName, StringComparison.Ordinal))
            {
                return true;
            }
            return allowObjectArray && IsObjectType(elementType);
        }

        private static bool IsObjectType(string typeName) =>
            string.Equals(typeName, "object", StringComparison.Ordinal) ||
            string.Equals(typeName, "System.Object", StringComparison.Ordinal);

        private static (bool ok, List<string> nonTargets, List<TargetCall> targets) Classify(
            string code,
            string ownerId,
            string propertyName)
        {
            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            if (HasParseErrors(root)) return (false, new List<string>(), new List<TargetCall>());
            var init = FormClassResolver.InitMethod(root);
            if (init?.Body == null) return (false, new List<string>(), new List<TargetCall>());

            var nonTargets = new List<string>();
            var targets = new List<TargetCall>();
            foreach (var st in init.Body.Statements)
            {
                if (TryGetTargetCall(st, ownerId, propertyName, out var target)) targets.Add(target);
                else nonTargets.Add(st.ToFullString());
            }
            return (true, nonTargets, targets);
        }

        private static List<string> CommentAndDirectiveTrivia(string code)
        {
            var list = new List<string>();
            var init = FormClassResolver.InitMethod(CSharpSyntaxTree.ParseText(code).GetRoot());
            if (init?.Body == null) return list;
            foreach (var trivia in init.Body.DescendantTrivia(descendIntoTrivia: true))
            {
                if (trivia.IsKind(SyntaxKind.SingleLineCommentTrivia) ||
                    trivia.IsKind(SyntaxKind.MultiLineCommentTrivia) ||
                    trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia) ||
                    trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia) ||
                    trivia.IsDirective)
                {
                    list.Add(trivia.ToString());
                }
            }
            return list;
        }

        private static bool TargetsOwner(StatementSyntax statement, string ownerId)
        {
            if (statement is not ExpressionStatementSyntax expressionStatement) return false;
            ExpressionSyntax? lhs = expressionStatement.Expression switch
            {
                AssignmentExpressionSyntax assignment => assignment.Left,
                InvocationExpressionSyntax invocation when invocation.Expression is MemberAccessExpressionSyntax memberAccess => memberAccess.Expression,
                _ => null,
            };
            if (lhs == null) return false;
            var chain = Flatten(lhs);
            return chain.Count >= 1 && chain[0] == ownerId;
        }

        private static bool MentionsIdentifier(StatementSyntax statement, string ownerId) =>
            statement.DescendantNodes().OfType<IdentifierNameSyntax>().Any(id => id.Identifier.ValueText == ownerId);

        private static string LineIndent(SyntaxNode node)
        {
            var text = node.SyntaxTree.GetText();
            string lineText = text.Lines.GetLineFromPosition(node.SpanStart).ToString();
            int n = lineText.Length - lineText.TrimStart().Length;
            return lineText.Substring(0, n);
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

        private static bool IsSingleExpression(string expression)
        {
            if (string.IsNullOrWhiteSpace(expression) || expression.Length > MaxExpressionChars) return false;
            var parsed = SyntaxFactory.ParseExpression(expression);
            if (parsed.ContainsDiagnostics) return false;
            return string.Equals(parsed.ToFullString().Trim(), expression.Trim(), StringComparison.Ordinal);
        }

        private static bool IsIdentifier(string value) =>
            !string.IsNullOrWhiteSpace(value) &&
            value.Length <= MaxIdentifierChars &&
            SyntaxFacts.IsValidIdentifier(value);

        private static bool HasParseErrors(SyntaxNode root) =>
            root.SyntaxTree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error);

        private static Dictionary<string, ItemTypeSpec> BuildScalarTypes()
        {
            var map = new Dictionary<string, ItemTypeSpec>(StringComparer.Ordinal);
            void Add(ItemKind kind, string canonical, string csharpType, params string[] aliases)
            {
                var spec = new ItemTypeSpec { Kind = kind, CanonicalName = canonical, CSharpTypeName = csharpType };
                map[canonical] = spec;
                map[csharpType] = spec;
                foreach (string alias in aliases) map[alias] = spec;
            }

            Add(ItemKind.String, "System.String", "string");
            Add(ItemKind.Boolean, "System.Boolean", "bool");
            Add(ItemKind.Char, "System.Char", "char");
            Add(ItemKind.SByte, "System.SByte", "sbyte");
            Add(ItemKind.Byte, "System.Byte", "byte");
            Add(ItemKind.Int16, "System.Int16", "short");
            Add(ItemKind.UInt16, "System.UInt16", "ushort");
            Add(ItemKind.Int32, "System.Int32", "int");
            Add(ItemKind.UInt32, "System.UInt32", "uint");
            Add(ItemKind.Int64, "System.Int64", "long");
            Add(ItemKind.UInt64, "System.UInt64", "ulong");
            Add(ItemKind.Single, "System.Single", "float");
            Add(ItemKind.Double, "System.Double", "double");
            Add(ItemKind.Decimal, "System.Decimal", "decimal");
            return map;
        }

        private static Dictionary<string, ItemTypeSpec> BuildEnumTypes(params Type[] enumTypes)
        {
            var map = new Dictionary<string, ItemTypeSpec>(StringComparer.Ordinal);
            foreach (Type type in enumTypes)
            {
                if (!type.IsEnum || type.FullName == null) continue;
                map[type.FullName] = new ItemTypeSpec
                {
                    Kind = ItemKind.Enum,
                    CanonicalName = type.FullName,
                    CSharpTypeName = type.FullName,
                    EnumType = type,
                };
            }
            return map;
        }
    }
}
