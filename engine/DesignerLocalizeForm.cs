using System;
using System.Collections.Generic;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    public sealed class LocalizeFormResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        /// <summary>The rewritten .Designer.cs — resource-driven, exactly as Visual Studio's Localizable = true writes it.</summary>
        public string? NewText { get; init; }
        /// <summary>The neutral sibling .resx carrying every moved value. Null when nothing had to move.</summary>
        public string? ResxText { get; init; }
        /// <summary>Resource keys written ("button1.Text", "$this.ClientSize", …) — for the host's log and tests.</summary>
        public List<string> Keys { get; init; } = new();
    }

    /// <summary>One localizable property that moves from generated code into the neutral .resx.</summary>
    public sealed class LocalizableValue
    {
        /// <summary>Component id: "this" for the form, else the field name.</summary>
        public string ComponentId { get; init; } = "";
        public string PropertyName { get; init; } = "";
        /// <summary>The value's type as <see cref="DesignerLocalizedResxEditor"/> names it.</summary>
        public string ValueTypeName { get; init; } = "";
        /// <summary>The live value, invariant-converted.</summary>
        public string InvariantValue { get; init; } = "";
    }

    /// <summary>
    /// Convert a plain designer file into a LOCALIZABLE one — the transformation Visual Studio performs when the
    /// form's Localizable property is set to true.
    ///
    /// Every localizable property assignment (Text, Location, Size, Anchor, Font, …) is lifted out of
    /// InitializeComponent into the neutral .resx and replaced by the ComponentResourceManager call that reads it
    /// back: `resources.ApplyResources(this.button1, "button1")`. Non-localizable assignments — Name, TabIndex,
    /// UseVisualStyleBackColor, event wiring, Controls.Add, everything structural — stay exactly where they are,
    /// which is also what Visual Studio does.
    ///
    /// The conversion is refused rather than approximated whenever it cannot be performed faithfully: a form that is
    /// already localizable, a value whose type the resx writer cannot round-trip, or an edit that would touch a
    /// statement it did not lift. A refusal leaves the file untouched.
    /// </summary>
    public static class DesignerLocalizeForm
    {
        private static readonly Dictionary<string, string> AddedControlLocalizableTypes = new(StringComparer.Ordinal)
        {
            ["AutoSize"] = "System.Boolean",
            ["Location"] = "System.Drawing.Point",
            ["Size"] = "System.Drawing.Size",
            ["Text"] = "System.String",
        };

        /// <summary>Compose the rewritten source + .resx. <paramref name="values"/> is the live-graph inventory of
        /// localizable properties the source assigns, gathered by the caller (which owns the design surface).</summary>
        public static LocalizeFormResult Apply(string src, string className, IReadOnlyList<LocalizableValue> values,
            string? existingResxText)
        {
            if (string.IsNullOrEmpty(src)) return Refuse("designer source is empty");
            if (!DesignerControlEditor.IsValidIdentifier(className)) return Refuse("invalid class name: " + className);

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = DesignerControlEditor.FindClassWithICShared(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return Refuse("InitializeComponent not found");
            if (init.Body.Statements.Any(IsApplyResourcesCall) || src.Contains("ComponentResourceManager", StringComparison.Ordinal))
                return Refuse("the form is already localizable");
            if (values.Count == 0) return Refuse("the form assigns no localizable properties");

            // Index the inventory so a statement can be matched to the value it carries.
            var wanted = new Dictionary<string, LocalizableValue>(StringComparer.Ordinal);
            foreach (var value in values)
            {
                if (!DesignerControlEditor.IsValidIdentifier(value.PropertyName)) return Refuse("invalid property: " + value.PropertyName);
                if (value.ComponentId != "this" && !DesignerControlEditor.IsValidIdentifier(value.ComponentId))
                    return Refuse("invalid component: " + value.ComponentId);
                wanted[value.ComponentId + "." + value.PropertyName] = value;
            }

            // Find the assignments to lift, and which components end up resource-driven.
            var lifted = new List<(StatementSyntax Statement, LocalizableValue Value)>();
            var owners = new List<string>();
            foreach (var st in init.Body.Statements)
            {
                if (st is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assign }) continue;
                if (!assign.OperatorToken.IsKind(SyntaxKind.EqualsToken)) continue;
                var chain = DesignerControlEditor.FlattenChain(assign.Left);
                string owner, property;
                if (chain.Count == 1) { owner = "this"; property = chain[0]; }
                else if (chain.Count == 2) { owner = chain[0]; property = chain[1]; }
                else continue;
                if (!wanted.TryGetValue(owner + "." + property, out var value)) continue;
                lifted.Add((st, value));
                if (!owners.Contains(owner)) owners.Add(owner);
            }
            if (lifted.Count == 0) return Refuse("no localizable assignment found in InitializeComponent");

            // Write every lifted value into the neutral .resx first: a value the writer cannot represent must stop
            // the conversion BEFORE any source is rewritten.
            var edits = lifted.Select(l => new LocalizedResourceEdit
            {
                Kind = LocalizedResourceEditKind.UpsertScalar,
                ComponentId = l.Value.ComponentId,
                PropertyName = l.Value.PropertyName,
                ValueTypeName = l.Value.ValueTypeName,
                ScalarValue = l.Value.InvariantValue,
            }).ToList();
            var resx = DesignerLocalizedResxEditor.ApplyScalarEdits(existingResxText, edits);
            if (!resx.Ok || resx.ResxText == null) return Refuse(resx.Reason);

            string nl = src.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
            string indent = DesignerControlEditor.StatementIndent(src, init);

            // Rewrite: drop the lifted lines, put one ApplyResources call where each component's first lifted
            // assignment was (Visual Studio's position for it), and declare the manager at the top of the method.
            var replacements = new List<(int Start, int End, string Text)>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (var (statement, value) in lifted)
            {
                var (start, end) = DesignerControlEditor.StatementLineRange(src, statement);
                string text = "";
                if (seen.Add(value.ComponentId))
                {
                    string target = value.ComponentId == "this" ? "this" : "this." + value.ComponentId;
                    string key = value.ComponentId == "this" ? "$this" : value.ComponentId;
                    text = indent + $"resources.ApplyResources({target}, \"{key}\");" + nl;
                }
                replacements.Add((start, end, text));
            }
            replacements.Sort((a, b) => b.Start.CompareTo(a.Start));
            string result = src;
            foreach (var (start, end, text) in replacements)
                result = result.Substring(0, start) + text + result.Substring(end);

            int declPos = DesignerControlEditor.FirstStatementLinePos(result, className);
            if (declPos < 0) return Refuse("could not place the resource manager declaration");
            result = result.Substring(0, declPos)
                + indent + $"System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof({className}));" + nl
                + result.Substring(declPos);

            if (CSharpSyntaxTree.ParseText(result).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error))
                return Refuse("the localized source has syntax errors");
            string? gate = VerifyOnlyLifted(src, result, lifted.Select(l => l.Statement).ToList(), owners, className);
            if (gate != null) return Refuse(gate);

            return new LocalizeFormResult { Safe = true, NewText = result, ResxText = resx.ResxText, Keys = resx.Keys.ToList() };
        }

        /// <summary>
        /// Convert the bounded property block emitted by <see cref="DesignerControlEditor.AddControl"/> into the
        /// shape Visual Studio uses on an already-localizable form: localizable values move to the neutral .resx and
        /// one existing ComponentResourceManager invokes ApplyResources for the new control. Structural statements,
        /// Name, TabIndex, visual-style state, field declaration and Controls.Add remain source-backed.
        /// </summary>
        public static LocalizeFormResult ApplyAddedControl(string src, string componentId, string? existingResxText)
        {
            if (string.IsNullOrEmpty(src)) return Refuse("designer source is empty");
            if (!DesignerControlEditor.IsValidIdentifier(componentId)) return Refuse("invalid component: " + componentId);

            var root = CSharpSyntaxTree.ParseText(src).GetRoot();
            var cls = DesignerControlEditor.FindClassWithICShared(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return Refuse("InitializeComponent not found");
            string? resourcesVariable = ExistingResourcesVariable(init, cls.Identifier.Text);
            if (resourcesVariable == null) return Refuse("a canonical same-form ComponentResourceManager was not found");
            if (!init.Body.Statements.Any(st => IsApplyResourcesCall(st, resourcesVariable)))
                return Refuse("the form is not already ApplyResources-backed");

            var lifted = new List<(StatementSyntax Statement, LocalizableValue Value)>();
            foreach (var statement in init.Body.Statements)
            {
                if (statement is not ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax assign }
                    || !assign.OperatorToken.IsKind(SyntaxKind.EqualsToken)) continue;
                var chain = DesignerControlEditor.FlattenChain(assign.Left);
                if (chain.Count != 2 || chain[0] != componentId
                    || !AddedControlLocalizableTypes.TryGetValue(chain[1], out string? valueType)) continue;
                if (!TryInvariantAddedValue(chain[1], assign.Right, out string invariant))
                    return Refuse("the added control carries an unsupported localizable value: " + chain[1]);
                lifted.Add((statement, new LocalizableValue
                {
                    ComponentId = componentId,
                    PropertyName = chain[1],
                    ValueTypeName = valueType,
                    InvariantValue = invariant,
                }));
            }
            if (lifted.Count == 0) return Refuse("the added control has no localizable property assignments");

            var edits = lifted.Select(item => new LocalizedResourceEdit
            {
                Kind = LocalizedResourceEditKind.UpsertScalar,
                ComponentId = componentId,
                PropertyName = item.Value.PropertyName,
                ValueTypeName = item.Value.ValueTypeName,
                ScalarValue = item.Value.InvariantValue,
            }).ToList();
            var resx = DesignerLocalizedResxEditor.ApplyScalarEdits(existingResxText, edits);
            if (!resx.Ok || resx.ResxText == null) return Refuse(resx.Reason);

            string nl = src.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
            string indent = DesignerControlEditor.StatementIndent(src, init);
            var replacements = new List<(int Start, int End, string Text)>();
            bool first = true;
            foreach (var item in lifted)
            {
                var range = DesignerControlEditor.StatementLineRange(src, item.Statement);
                string replacement = first
                    ? indent + resourcesVariable + $".ApplyResources(this.{componentId}, \"{componentId}\");" + nl
                    : "";
                replacements.Add((range.Start, range.End, replacement));
                first = false;
            }
            replacements.Sort((a, b) => b.Start.CompareTo(a.Start));
            string result = src;
            foreach (var replacement in replacements)
                result = result.Substring(0, replacement.Start) + replacement.Text + result.Substring(replacement.End);

            if (CSharpSyntaxTree.ParseText(result).GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error))
                return Refuse("the localized add source has syntax errors");
            string? gate = VerifyAddedControlLift(src, result, lifted.Select(item => item.Statement), resourcesVariable, componentId);
            if (gate != null) return Refuse(gate);
            return new LocalizeFormResult { Safe = true, NewText = result, ResxText = resx.ResxText, Keys = resx.Keys.ToList() };
        }

        private static string? ExistingResourcesVariable(MethodDeclarationSyntax init, string className)
        {
            var candidates = new List<string>();
            foreach (var local in init.Body!.Statements.OfType<LocalDeclarationStatementSyntax>())
            {
                string type = local.Declaration.Type.ToString().Replace("global::", "", StringComparison.Ordinal);
                if (type.Substring(type.LastIndexOf('.') + 1).TrimEnd('?') != "ComponentResourceManager") continue;
                foreach (var variable in local.Declaration.Variables)
                {
                    if (variable.Initializer?.Value is not ObjectCreationExpressionSyntax creation
                        || creation.ArgumentList?.Arguments.Count != 1
                        || creation.ArgumentList.Arguments[0].Expression is not TypeOfExpressionSyntax typeOf
                        || typeOf.Type.ToString().Replace("global::", "", StringComparison.Ordinal).Split('.').Last() != className)
                        continue;
                    candidates.Add(variable.Identifier.ValueText);
                }
            }
            return candidates.Distinct(StringComparer.Ordinal).Take(2).Count() == 1 ? candidates[0] : null;
        }

        private static bool IsApplyResourcesCall(StatementSyntax statement, string receiver) =>
            statement is ExpressionStatementSyntax
            {
                Expression: InvocationExpressionSyntax
                {
                    Expression: MemberAccessExpressionSyntax
                    {
                        Expression: IdentifierNameSyntax id,
                        Name.Identifier.Text: "ApplyResources",
                    },
                },
            } && id.Identifier.ValueText == receiver;

        private static bool TryInvariantAddedValue(string propertyName, ExpressionSyntax expression, out string value)
        {
            value = "";
            if (propertyName == "Text" && expression is LiteralExpressionSyntax text
                && text.IsKind(SyntaxKind.StringLiteralExpression))
            {
                value = text.Token.ValueText;
                return true;
            }
            if (propertyName == "AutoSize" && expression is LiteralExpressionSyntax boolean
                && (boolean.IsKind(SyntaxKind.TrueLiteralExpression) || boolean.IsKind(SyntaxKind.FalseLiteralExpression)))
            {
                value = boolean.IsKind(SyntaxKind.TrueLiteralExpression) ? "True" : "False";
                return true;
            }
            if ((propertyName == "Location" || propertyName == "Size")
                && expression is ObjectCreationExpressionSyntax creation
                && creation.ArgumentList?.Arguments.Count == 2
                && TryInteger(creation.ArgumentList.Arguments[0].Expression, out int x)
                && TryInteger(creation.ArgumentList.Arguments[1].Expression, out int y))
            {
                string expected = propertyName == "Location" ? "Point" : "Size";
                string actual = creation.Type.ToString().Replace("global::", "", StringComparison.Ordinal);
                actual = actual.Substring(actual.LastIndexOf('.') + 1);
                if (actual != expected) return false;
                value = x.ToString(System.Globalization.CultureInfo.InvariantCulture) + ", "
                    + y.ToString(System.Globalization.CultureInfo.InvariantCulture);
                return true;
            }
            return false;
        }

        private static bool TryInteger(ExpressionSyntax expression, out int value)
        {
            if (expression is LiteralExpressionSyntax literal && literal.Token.Value is int integer)
            {
                value = integer;
                return true;
            }
            if (expression is PrefixUnaryExpressionSyntax unary
                && unary.IsKind(SyntaxKind.UnaryMinusExpression)
                && unary.Operand is LiteralExpressionSyntax operand && operand.Token.Value is int positive)
            {
                value = -positive;
                return true;
            }
            value = 0;
            return false;
        }

        private static string? VerifyAddedControlLift(string original, string edited,
            IEnumerable<StatementSyntax> lifted, string resourcesVariable, string componentId)
        {
            var before = DesignerControlEditor.InitStatementTexts(original);
            var after = DesignerControlEditor.InitStatementTexts(edited);
            var removed = Multiset(before);
            foreach (var text in after) Decrement(removed, text);
            var added = Multiset(after);
            foreach (var text in before) Decrement(added, text);
            var expectedRemoved = Multiset(lifted.Select(statement => DesignerControlEditor.Normalize(statement.ToString())));
            var expectedAdded = Multiset(new[] { DesignerControlEditor.Normalize(
                resourcesVariable + $".ApplyResources(this.{componentId}, \"{componentId}\");") });
            if (!SameMultiset(removed, expectedRemoved)) return "the localized add removed statements outside the added control's localizable block";
            if (!SameMultiset(added, expectedAdded)) return "the localized add inserted statements outside the ApplyResources call";
            return null;
        }

        /// <summary>
        /// The safe-save gate: the rewrite must remove ONLY the lifted assignments and add ONLY the manager
        /// declaration plus one ApplyResources call per affected component. Any other difference — a statement
        /// dropped, reordered into a different multiset, an extra call — fails the conversion.
        /// </summary>
        private static string? VerifyOnlyLifted(string original, string edited, List<StatementSyntax> lifted,
            List<string> owners, string className)
        {
            var before = DesignerControlEditor.InitStatementTexts(original);
            var after = DesignerControlEditor.InitStatementTexts(edited);

            var expectedRemovals = lifted.Select(st => DesignerControlEditor.Normalize(st.ToString())).ToList();
            var expectedAdditions = new List<string>
            {
                DesignerControlEditor.Normalize(
                    $"System.ComponentModel.ComponentResourceManager resources = new System.ComponentModel.ComponentResourceManager(typeof({className}));"),
            };
            foreach (var owner in owners)
            {
                string target = owner == "this" ? "this" : "this." + owner;
                string key = owner == "this" ? "$this" : owner;
                expectedAdditions.Add(DesignerControlEditor.Normalize($"resources.ApplyResources({target}, \"{key}\");"));
            }

            var removed = Multiset(before);
            foreach (var text in after) Decrement(removed, text);
            var added = Multiset(after);
            foreach (var text in before) Decrement(added, text);

            if (!SameMultiset(removed, Multiset(expectedRemovals))) return "the rewrite removed statements it did not lift";
            if (!SameMultiset(added, Multiset(expectedAdditions))) return "the rewrite added statements it did not compose";
            return null;
        }

        private static Dictionary<string, int> Multiset(IEnumerable<string> items)
        {
            var counter = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var item in items) counter[item] = counter.TryGetValue(item, out var n) ? n + 1 : 1;
            return counter;
        }

        private static void Decrement(Dictionary<string, int> counter, string key)
        {
            if (!counter.TryGetValue(key, out var n)) return;
            if (n <= 1) counter.Remove(key); else counter[key] = n - 1;
        }

        private static bool SameMultiset(Dictionary<string, int> a, Dictionary<string, int> b) =>
            a.Count == b.Count && a.All(kv => b.TryGetValue(kv.Key, out var n) && n == kv.Value);

        private static bool IsApplyResourcesCall(StatementSyntax st) =>
            st is ExpressionStatementSyntax { Expression: InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax ma } }
            && ma.Name.Identifier.Text == "ApplyResources";

        private static LocalizeFormResult Refuse(string reason) => new() { Safe = false, Reason = reason };
    }
}
