using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    public sealed class DesignerOwnedRegionPlanRequest
    {
        public string SourceText { get; init; } = "";
        public string ExpectedSourceSha256 { get; init; } = "";
        public string ComponentName { get; init; } = "";
        public string PropertyName { get; init; } = "";
        public string ValueExpression { get; init; } = "";
    }

    public sealed class DesignerOwnedRegionPatchRequest
    {
        public string SourceText { get; init; } = "";
        public string ExpectedSourceSha256 { get; init; } = "";
        public string ProposedSourceText { get; init; } = "";
        public string ComponentName { get; init; } = "";
        public string PatchLabel { get; init; } = "";
    }

    public sealed class DesignerOwnedRegionPlanResult
    {
        public bool Safe { get; init; }
        public string Reason { get; init; } = "";
        public string ExpectedSourceSha256 { get; init; } = "";
        public string ActualSourceSha256 { get; init; } = "";
        public string ComponentName { get; init; } = "";
        public string PropertyName { get; init; } = "";
        public EditMode Mode { get; init; } = EditMode.Failed;
        public int OwnedRegionStart { get; init; } = -1;
        public int OwnedRegionEnd { get; init; } = -1;
        public string ReplacementText { get; init; } = "";
        public string PlannedSourceText { get; init; } = "";
        public string LaneASourceText { get; init; } = "";
        public string NormalizationPreview { get; init; } = "";
        public bool SemanticEquivalence { get; init; }
        public bool OutsideRegionPreserved { get; init; }
    }

    /// <summary>
    /// Phase 0 Lane B kill-spike for designer-owned InitializeComponent region replacement.
    /// It proves the region and semantic postconditions before returning a plan; callers still
    /// apply it through the ordinary transaction path.
    /// </summary>
    public static class DesignerOwnedRegionSerializer
    {
        public static string Sha256Hex(string text)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(text ?? "");
            return Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        }

        public static DesignerOwnedRegionPlanResult PlanPropertySet(
            DesignerOwnedRegionPlanRequest request,
            bool fullCoverageAlreadyProven = false)
        {
            request ??= new DesignerOwnedRegionPlanRequest();
            string source = request.SourceText ?? "";
            string componentName = string.IsNullOrEmpty(request.ComponentName) ? "this" : request.ComponentName;
            string actual = Sha256Hex(source);
            string expected = (request.ExpectedSourceSha256 ?? "").Trim();
            if (!IsSha256(expected))
                return Refused(request, expected, actual, "expected source fingerprint is not a lowercase SHA-256 hex value");
            if (!string.Equals(expected, actual, StringComparison.Ordinal))
                return Refused(request, expected, actual, "stale source fingerprint");
            if (componentName != "this" && !DesignerControlEditor.IsValidIdentifier(componentName))
                return Refused(request, expected, actual, "invalid component name");
            if (!DesignerControlEditor.IsValidIdentifier(request.PropertyName))
                return Refused(request, expected, actual, "invalid property name");

            var parse = Parse(source);
            if (!parse.Ok)
                return Refused(request, expected, actual, parse.Reason);

            string originalIr;
            if (fullCoverageAlreadyProven)
            {
                // RenderWithLayout already built the exact source into a zero-gap retained DesignSurface. The opaque
                // graph token/path/source proof is checked by DesignerRenderer before this flag can be true, so another
                // whole-form IR construction adds no evidence. Direct callers keep the full build below.
                originalIr = "retained-full-coverage:" + actual;
            }
            else
            {
                string? builtIr = IrSignature(source, out string originalIrReason);
                if (builtIr == null)
                    return Refused(request, expected, actual, originalIrReason);
                originalIr = builtIr;
            }

            var laneA = DesignerPropertyEditor.EditProperty(
                source,
                componentName,
                request.PropertyName,
                request.ValueExpression);
            if (laneA.Mode == EditMode.Failed || string.IsNullOrEmpty(laneA.NewText))
                return Refused(request, expected, actual, "Lane A planner refused: " + laneA.Reason);
            var laneAParse = Parse(laneA.NewText);
            if (!laneAParse.Ok)
                return Refused(request, expected, actual, "Lane A output is not owned-region safe: " + laneAParse.Reason);
            if (!DesignerPropertyEditor.OnlyTargetChanged(
                parse.Body!, laneAParse.Body!, componentName, request.PropertyName, laneA.Mode))
                return Refused(request, expected, actual, "Lane A planner changed more than the target property");

            string replacement = laneA.NewText.Substring(laneAParse.BodyStart, laneAParse.BodyEnd - laneAParse.BodyStart);
            string planned = source.Substring(0, parse.BodyStart) + replacement + source.Substring(parse.BodyEnd);
            bool outsidePreserved = source.AsSpan(0, parse.BodyStart).SequenceEqual(planned.AsSpan(0, parse.BodyStart))
                && source.AsSpan(parse.BodyEnd).SequenceEqual(planned.AsSpan(parse.BodyStart + replacement.Length));
            bool textEquivalent = string.Equals(planned, laneA.NewText, StringComparison.Ordinal);

            if (!outsidePreserved)
                return Refused(request, expected, actual, "owned-region splice would change bytes outside InitializeComponent");
            // Semantic equivalence to Lane A follows from exact byte equality. The original full-coverage IR proof above
            // remains mandatory; rebuilding the same dense IR twice more for the byte-identical Lane A/planned outputs
            // added no independent evidence and made the first VS property commit scale with three whole-form IR builds.
            if (!textEquivalent)
                return Refused(request, expected, actual, "Lane B owned-region replacement is not equivalent to Lane A");

            return new DesignerOwnedRegionPlanResult
            {
                Safe = true,
                ExpectedSourceSha256 = expected,
                ActualSourceSha256 = actual,
                ComponentName = componentName,
                PropertyName = request.PropertyName,
                Mode = laneA.Mode,
                OwnedRegionStart = parse.BodyStart,
                OwnedRegionEnd = parse.BodyEnd,
                ReplacementText = replacement,
                PlannedSourceText = planned,
                LaneASourceText = laneA.NewText,
                OutsideRegionPreserved = true,
                SemanticEquivalence = true,
                NormalizationPreview = Preview(parse.BodyStart, parse.BodyEnd, replacement, originalIr, laneA.NewText),
            };
        }

        public static DesignerOwnedRegionPlanResult PlanBoundedComponentPatch(DesignerOwnedRegionPatchRequest request)
        {
            request ??= new DesignerOwnedRegionPatchRequest();
            string source = request.SourceText ?? "";
            string proposed = request.ProposedSourceText ?? "";
            string componentName = request.ComponentName ?? "";
            string actual = Sha256Hex(source);
            string expected = (request.ExpectedSourceSha256 ?? "").Trim();
            if (!IsSha256(expected))
                return Refused(request, expected, actual, "expected source fingerprint is not a lowercase SHA-256 hex value");
            if (!string.Equals(expected, actual, StringComparison.Ordinal))
                return Refused(request, expected, actual, "stale source fingerprint");
            if (!DesignerControlEditor.IsValidIdentifier(componentName))
                return Refused(request, expected, actual, "invalid component name");
            if (string.IsNullOrWhiteSpace(proposed))
                return Refused(request, expected, actual, "proposed source is empty");

            var parse = Parse(source);
            if (!parse.Ok)
                return Refused(request, expected, actual, parse.Reason);
            var proposedParse = Parse(proposed);
            if (!proposedParse.Ok)
                return Refused(request, expected, actual, "proposed source is not owned-region safe: " + proposedParse.Reason);

            string? originalIr = IrSignature(source, out string originalIrReason);
            if (originalIr == null)
                return Refused(request, expected, actual, originalIrReason);
            string? proposedIr = IrSignature(proposed, out string proposedIrReason);
            if (proposedIr == null)
                return Refused(request, expected, actual, "proposed source is not semantically representable: " + proposedIrReason);

            bool outsidePreserved = source.AsSpan(0, parse.BodyStart).SequenceEqual(proposed.AsSpan(0, proposedParse.BodyStart))
                && source.AsSpan(parse.BodyEnd).SequenceEqual(proposed.AsSpan(proposedParse.BodyEnd));
            if (!outsidePreserved)
                return Refused(request, expected, actual, "owned-region violation: patch changes bytes outside InitializeComponent");

            if (!ChangedStatementsAreOwnedByComponent(source, proposed, componentName, out var violation))
                return Refused(request, expected, actual, "owned-region violation: " + violation);

            string replacement = proposed.Substring(proposedParse.BodyStart, proposedParse.BodyEnd - proposedParse.BodyStart);
            return new DesignerOwnedRegionPlanResult
            {
                Safe = true,
                ExpectedSourceSha256 = expected,
                ActualSourceSha256 = actual,
                ComponentName = componentName,
                PropertyName = request.PatchLabel ?? "",
                Mode = EditMode.Replace,
                OwnedRegionStart = parse.BodyStart,
                OwnedRegionEnd = parse.BodyEnd,
                ReplacementText = replacement,
                PlannedSourceText = proposed,
                LaneASourceText = proposed,
                OutsideRegionPreserved = true,
                SemanticEquivalence = true,
                NormalizationPreview = "Validate bounded component patch for " + componentName
                    + " inside InitializeComponent; semanticHash="
                    + Sha256Hex(originalIr)[..12] + "->" + Sha256Hex(proposedIr)[..12]
                    + "; outsideRegionPreserved=true",
            };
        }

        private static string Preview(int start, int end, string replacement, string beforeIr, string laneABytes)
        {
            string newline = replacement.Contains("\r\n", StringComparison.Ordinal) ? "CRLF" : "LF";
            return "Replace InitializeComponent owned body [" + start + "," + end + ") with "
                + replacement.Length + " bytes; lineEnding=" + newline
                + "; originalIrHash=" + Sha256Hex(beforeIr)[..12]
                + "; laneABytesHash=" + Sha256Hex(laneABytes)[..12]
                + "; outsideRegionPreserved=true";
        }

        private static DesignerOwnedRegionPlanResult Refused(
            DesignerOwnedRegionPlanRequest request,
            string expected,
            string actual,
            string reason) => new()
            {
                Safe = false,
                Reason = reason,
                ExpectedSourceSha256 = expected,
                ActualSourceSha256 = actual,
                ComponentName = request.ComponentName,
                PropertyName = request.PropertyName,
                Mode = EditMode.Failed,
            };

        private static DesignerOwnedRegionPlanResult Refused(
            DesignerOwnedRegionPatchRequest request,
            string expected,
            string actual,
            string reason) => new()
            {
                Safe = false,
                Reason = reason,
                ExpectedSourceSha256 = expected,
                ActualSourceSha256 = actual,
                ComponentName = request.ComponentName,
                PropertyName = request.PatchLabel,
                Mode = EditMode.Failed,
            };

        private static bool ChangedStatementsAreOwnedByComponent(
            string original,
            string proposed,
            string componentName,
            out string reason)
        {
            reason = "";
            var originalStatements = InitStatements(original);
            var proposedStatements = InitStatements(proposed);
            var proposedCounter = Counter(proposedStatements.Select(NormalizeStatement));
            foreach (var statement in originalStatements)
            {
                string key = NormalizeStatement(statement);
                if (proposedCounter.TryGetValue(key, out var count) && count > 0)
                {
                    proposedCounter[key] = count - 1;
                    continue;
                }
                if (!StatementBelongsToComponent(statement, componentName))
                {
                    reason = "original statement outside '" + componentName + "' would change: " + NormalizeStatement(statement);
                    return false;
                }
            }

            var originalCounter = Counter(originalStatements.Select(NormalizeStatement));
            foreach (var statement in proposedStatements)
            {
                string key = NormalizeStatement(statement);
                if (originalCounter.TryGetValue(key, out var count) && count > 0)
                {
                    originalCounter[key] = count - 1;
                    continue;
                }
                if (!StatementBelongsToComponent(statement, componentName))
                {
                    reason = "proposed statement outside '" + componentName + "' would change: " + NormalizeStatement(statement);
                    return false;
                }
            }
            return true;
        }

        private static List<StatementSyntax> InitStatements(string source)
        {
            var root = CSharpSyntaxTree.ParseText(source ?? "").GetRoot();
            var init = FormClassResolver.InitMethod(root);
            return init?.Body?.Statements.ToList() ?? new List<StatementSyntax>();
        }

        private static bool StatementBelongsToComponent(StatementSyntax statement, string componentName)
        {
            if (statement is not ExpressionStatementSyntax expressionStatement)
                return false;

            ExpressionSyntax? target = expressionStatement.Expression switch
            {
                AssignmentExpressionSyntax assignment => assignment.Left,
                InvocationExpressionSyntax invocation when invocation.Expression is MemberAccessExpressionSyntax member => member.Expression,
                _ => null,
            };
            if (target == null) return false;
            var flattened = Flatten(target);
            return flattened.Count > 0 && flattened[0] == componentName;
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
                        names.Add(member.Name.Identifier.Text);
                        break;
                    case ThisExpressionSyntax:
                        break;
                    case IdentifierNameSyntax identifier:
                        names.Add(identifier.Identifier.Text);
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

        private static string NormalizeStatement(SyntaxNode statement) =>
            new string(statement.ToString().Where(c => !char.IsWhiteSpace(c)).ToArray());

        private static Dictionary<string, int> Counter(IEnumerable<string> values)
        {
            var counter = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var value in values)
                counter[value] = counter.TryGetValue(value, out var count) ? count + 1 : 1;
            return counter;
        }

        private static string? IrSignature(string source, out string reason)
        {
            reason = "";
            var doc = DesignerIrBuilder.Build(source);
            string? invalid = IrValidate.Check(doc);
            if (invalid != null)
            {
                reason = "IR validation failed: " + invalid;
                return null;
            }
            if (doc == null || !doc.FullCoverage)
            {
                reason = "InitializeComponent has unmodeled statements: "
                    + string.Join("; ", doc?.UnrepresentableReasons.Take(3) ?? Array.Empty<string>());
                return null;
            }

            var builder = new StringBuilder();
            builder.Append(doc.SchemaVersion).Append('|')
                .Append(doc.DesignedTypeName).Append('|')
                .Append(doc.BaseTypeSyntaxName).Append('|')
                .Append(doc.TotalSourceStatements).Append('|')
                .Append(doc.RepresentedStatements);
            foreach (var statement in doc.Statements)
            {
                builder.AppendLine();
                AppendStatement(builder, statement);
            }
            return builder.ToString();
        }

        private static ParseResult Parse(string source)
        {
            var tree = CSharpSyntaxTree.ParseText(source ?? "");
            if (tree.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error))
                return ParseResult.Fail("source has syntax errors");
            var root = tree.GetRoot();
            var candidates = root.DescendantNodes()
                .OfType<ClassDeclarationSyntax>()
                .Where(c => FormClassResolver.InitMethodOf(c) != null)
                .ToList();
            if (candidates.Count == 0)
                return ParseResult.Fail("InitializeComponent not found");
            if (candidates.Count != 1)
                return ParseResult.Fail("ambiguous InitializeComponent declarations");
            var init = FormClassResolver.InitMethodOf(candidates[0]);
            if (init?.Body == null)
                return ParseResult.Fail("InitializeComponent not found");
            if (ContainsUnsafeTrivia(init.Body))
                return ParseResult.Fail("InitializeComponent contains a comment, directive, disabled text, or skipped token");
            return new ParseResult(true, "", init.Body.OpenBraceToken.Span.End, init.Body.CloseBraceToken.SpanStart, init.Body);
        }

        private static bool ContainsUnsafeTrivia(SyntaxNode node)
        {
            foreach (var trivia in node.DescendantTrivia(descendIntoTrivia: true))
            {
                if (trivia.IsDirective || trivia.IsKind(SyntaxKind.SingleLineCommentTrivia)
                    || trivia.IsKind(SyntaxKind.MultiLineCommentTrivia)
                    || trivia.IsKind(SyntaxKind.SingleLineDocumentationCommentTrivia)
                    || trivia.IsKind(SyntaxKind.MultiLineDocumentationCommentTrivia)
                    || trivia.IsKind(SyntaxKind.DisabledTextTrivia)
                    || trivia.IsKind(SyntaxKind.SkippedTokensTrivia))
                {
                    return true;
                }
            }
            return false;
        }

        private static bool IsSha256(string value) =>
            value.Length == 64 && value.All(c => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'));

        private static void AppendStatement(StringBuilder builder, IrStatement statement)
        {
            switch (statement)
            {
                case IrConstructComponent c:
                    builder.Append("construct:").Append(c.Name).Append(':').Append(c.TypeName).Append(':').Append(c.WithComponentsContainer);
                    break;
                case IrSetProperty p:
                    builder.Append("set:").Append(Target(p.TargetIsRoot, p.TargetName)).Append(':')
                        .Append(string.Join(".", p.PropertyPath)).Append('=');
                    AppendValue(builder, p.Value);
                    break;
                case IrAddControl a:
                    builder.Append("addControl:").Append(Target(a.ParentIsRoot, a.ParentName)).Append(':')
                        .Append(string.Join(".", a.ParentPath)).Append(':').Append(a.ChildName).Append(':')
                        .Append(a.Column).Append(':').Append(a.Row);
                    break;
                case IrAddCollectionItem i:
                    builder.Append("addItem:").Append(Target(i.TargetIsRoot, i.TargetName)).Append(':')
                        .Append(string.Join(".", i.PropertyPath)).Append('=');
                    AppendValue(builder, i.Item);
                    break;
                case IrSetExtender x:
                    builder.Append("extender:").Append(x.ProviderName).Append(':')
                        .Append(Target(x.TargetIsRoot, x.TargetName)).Append(':').Append(x.PropertyName).Append('=');
                    AppendValue(builder, x.Value);
                    break;
                case IrApplyResources r:
                    builder.Append("resources:").Append(Target(r.TargetIsRoot, r.TargetName)).Append(':').Append(r.ResourceKey);
                    break;
                case IrBeginInit b:
                    builder.Append("beginInit:").Append(b.TargetName).Append(':').Append(string.Join(".", b.TargetPath));
                    break;
                case IrEndInit e:
                    builder.Append("endInit:").Append(e.TargetName).Append(':').Append(string.Join(".", e.TargetPath));
                    break;
                case IrWireEvent w:
                    builder.Append("event:").Append(Target(w.TargetIsRoot, w.TargetName)).Append(':')
                        .Append(w.EventName).Append(':').Append(w.HandlerName);
                    break;
                case IrLayoutCall l:
                    builder.Append("layout:").Append(Target(l.TargetIsRoot, l.TargetName)).Append(':')
                        .Append(string.Join(".", l.TargetPath)).Append(':').Append(l.Op).Append(':')
                        .Append(l.Arg).Append(':').Append(l.HasArg);
                    break;
                case IrConstructTreeNode t:
                    builder.Append("treeNode:").Append(t.LocalName).Append(':').Append(t.Text).Append(':')
                        .Append(string.Join(",", t.ChildLocalNames));
                    break;
                case IrSetTreeNodeProp p:
                    builder.Append("treeProp:").Append(p.LocalName).Append(':').Append(p.PropName).Append('=');
                    AppendValue(builder, p.Value);
                    break;
                case IrAddTreeNodes a:
                    builder.Append("treeAdd:").Append(Target(a.TargetIsRoot, a.TargetName)).Append(':')
                        .Append(string.Join(".", a.PropertyPath)).Append(':').Append(string.Join(",", a.NodeLocalNames));
                    break;
                default:
                    builder.Append(statement.GetType().FullName);
                    break;
            }
        }

        private static string Target(bool isRoot, string name) => isRoot ? "this" : name;

        private static void AppendValue(StringBuilder builder, IrValue value)
        {
            switch (value)
            {
                case IrNull:
                    builder.Append("null");
                    break;
                case IrBool b:
                    builder.Append("bool:").Append(b.Value);
                    break;
                case IrChar c:
                    builder.Append("char:").Append((int)c.Value);
                    break;
                case IrString s:
                    builder.Append("string:").Append(s.Value);
                    break;
                case IrNumber n:
                    builder.Append("number:").Append(n.Kind).Append(':').Append(n.InvariantText);
                    break;
                case IrEnum e:
                    builder.Append("enum:").Append(e.EnumTypeName).Append(':').Append(string.Join("|", e.Members));
                    break;
                case IrKnownCtor c:
                    builder.Append("ctor:").Append(c.TypeName).Append('(');
                    AppendValues(builder, c.Args);
                    builder.Append(')');
                    break;
                case IrStaticFactory f:
                    builder.Append("factory:").Append(f.TypeName).Append('.').Append(f.Method).Append('(');
                    AppendValues(builder, f.Args);
                    builder.Append(')');
                    break;
                case IrStaticRead r:
                    builder.Append("read:").Append(r.TypeName).Append('.').Append(r.Member);
                    break;
                case IrComponentRef r:
                    builder.Append("ref:").Append(Target(r.IsRoot, r.Name));
                    break;
                case IrArray a:
                    builder.Append("array:").Append(a.ElementTypeName).Append('[');
                    AppendValues(builder, a.Items);
                    builder.Append(']');
                    break;
                case IrResourceRef r:
                    builder.Append("res:").Append(r.IsString).Append(':').Append(r.Key);
                    break;
                case IrCast c:
                    builder.Append("cast:").Append(c.TargetTypeName).Append('(');
                    AppendValue(builder, c.Inner);
                    builder.Append(')');
                    break;
                default:
                    builder.Append(value.GetType().FullName);
                    break;
            }
        }

        private static void AppendValues(StringBuilder builder, IReadOnlyList<IrValue> values)
        {
            for (int i = 0; i < values.Count; i++)
            {
                if (i > 0) builder.Append(',');
                AppendValue(builder, values[i]);
            }
        }

        private readonly record struct ParseResult(bool Ok, string Reason, int BodyStart, int BodyEnd, BlockSyntax? Body)
        {
            public static ParseResult Fail(string reason) => new(false, reason, -1, -1, null);
        }
    }
}
