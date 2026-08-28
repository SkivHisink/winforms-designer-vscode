using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Xml;
using System.Xml.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>One strongly typed image/bitmap/icon resource that can be assigned by source expression.</summary>
    public sealed class ProjectResourceCandidate
    {
        public string Key { get; init; } = "";
        public string PropertyName { get; init; } = "";
        public string ResourceClassName { get; init; } = "";
        public string ResourceClassFullName { get; init; } = "";
        public string ValueTypeName { get; init; } = "";
        public string StorageKind { get; init; } = "";
    }

    /// <summary>Fail-closed list result for existing-project image resources.</summary>
    public sealed class ProjectResourceListResult
    {
        public bool Ok { get; init; }
        public string Reason { get; init; } = "";
        public List<ProjectResourceCandidate> Candidates { get; init; } = new();
    }

    /// <summary>
    /// Existing-project resource picker for image-like properties. It never reads paths from ResXFileRef values and
    /// never materializes serialized resources; it only cross-checks safe .resx metadata with strongly typed
    /// Resources.Designer.cs accessors and emits a resource property expression for DesignerPropertyEditor.
    /// </summary>
    public static class DesignerProjectResourcePicker
    {
        private const int MaxTextChars = 64 * 1024 * 1024;
        private const int MaxResources = 20000;

        private static readonly HashSet<string> ImageTypes = new(StringComparer.Ordinal)
        {
            "System.Drawing.Image",
            "System.Drawing.Bitmap",
            "System.Drawing.Icon",
        };

        public static ProjectResourceListResult ListImageResources(string? resxText, string? resourcesDesignerSource)
        {
            if (string.IsNullOrWhiteSpace(resxText))
                return Fail("resource .resx text is empty");
            if (string.IsNullOrWhiteSpace(resourcesDesignerSource))
                return Fail("strongly typed resource designer source is empty");
            if (resxText.Length > MaxTextChars)
                return Fail("resource .resx text is too large");
            if (resourcesDesignerSource.Length > MaxTextChars)
                return Fail("resource designer source is too large");

            var resources = ParseResx(resxText, out var resxReason);
            if (resources == null) return Fail(resxReason);

            var properties = ParseGeneratedProperties(resourcesDesignerSource, out var sourceReason);
            if (properties == null) return Fail(sourceReason);

            var candidates = new List<ProjectResourceCandidate>();
            foreach (var prop in properties.OrderBy(p => p.PropertyName, StringComparer.Ordinal))
            {
                if (!resources.TryGetValue(prop.Key, out var meta)) continue;
                if (!TypesCompatible(meta.ValueTypeName, prop.ValueTypeName))
                    return Fail("generated property '" + prop.ResourceClassFullName + "." + prop.PropertyName
                        + "' type does not match .resx key '" + prop.Key + "'");

                candidates.Add(new ProjectResourceCandidate
                {
                    Key = prop.Key,
                    PropertyName = prop.PropertyName,
                    ResourceClassName = prop.ResourceClassName,
                    ResourceClassFullName = prop.ResourceClassFullName,
                    ValueTypeName = prop.ValueTypeName,
                    StorageKind = meta.StorageKind,
                });
            }

            return new ProjectResourceListResult { Ok = true, Candidates = candidates };
        }

        public static string? BuildResourceExpression(
            string? resxText,
            string? resourcesDesignerSource,
            string resourceClassFullName,
            string resourcePropertyName,
            string targetPropertyTypeName,
            out string reason)
        {
            reason = "";
            if (!IsValidQualifiedName(resourceClassFullName))
            {
                reason = "invalid resource class name: " + resourceClassFullName;
                return null;
            }
            if (!DesignerControlEditor.IsValidIdentifier(resourcePropertyName))
            {
                reason = "invalid resource property name: " + resourcePropertyName;
                return null;
            }
            string targetType = NormalizeType(targetPropertyTypeName);
            if (!ImageTypes.Contains(targetType))
            {
                reason = "target property is not an image/icon type: " + targetPropertyTypeName;
                return null;
            }

            var listed = ListImageResources(resxText, resourcesDesignerSource);
            if (!listed.Ok)
            {
                reason = listed.Reason;
                return null;
            }

            var matches = listed.Candidates.Where(c =>
                string.Equals(c.ResourceClassFullName, resourceClassFullName, StringComparison.Ordinal)
                && string.Equals(c.PropertyName, resourcePropertyName, StringComparison.Ordinal)).ToList();

            if (matches.Count == 0)
            {
                reason = "resource candidate not found: " + resourceClassFullName + "." + resourcePropertyName;
                return null;
            }
            if (matches.Count != 1)
            {
                reason = "resource candidate is ambiguous: " + resourceClassFullName + "." + resourcePropertyName;
                return null;
            }
            if (!TypesAssignableToTarget(matches[0].ValueTypeName, targetType))
            {
                reason = "resource type '" + matches[0].ValueTypeName + "' cannot be assigned to target property type '" + targetType + "'";
                return null;
            }

            string expr = "global::" + resourceClassFullName + "." + resourcePropertyName;
            if (!IsSafeGeneratedExpression(expr, resourceClassFullName, resourcePropertyName))
            {
                reason = "resource expression shape is unsafe";
                return null;
            }
            return expr;
        }

        private static ProjectResourceListResult Fail(string reason) =>
            new() { Ok = false, Reason = string.IsNullOrWhiteSpace(reason) ? "resource picker refused the input" : reason };

        private sealed class ResourceMeta
        {
            public string ValueTypeName { get; init; } = "";
            public string StorageKind { get; init; } = "";
        }

        private sealed class GeneratedResourceProperty
        {
            public string Key { get; init; } = "";
            public string PropertyName { get; init; } = "";
            public string ResourceClassName { get; init; } = "";
            public string ResourceClassFullName { get; init; } = "";
            public string ValueTypeName { get; init; } = "";
        }

        private static Dictionary<string, ResourceMeta>? ParseResx(string text, out string reason)
        {
            reason = "";
            XDocument doc;
            try
            {
                var settings = new XmlReaderSettings
                {
                    DtdProcessing = DtdProcessing.Prohibit,
                    XmlResolver = null,
                    MaxCharactersInDocument = MaxTextChars,
                };
                using var sr = new StringReader(text);
                using var xr = XmlReader.Create(sr, settings);
                doc = XDocument.Load(xr);
            }
            catch (Exception ex)
            {
                reason = "resource .resx XML is malformed: " + ex.GetType().Name;
                return null;
            }
            if (doc.Root == null || doc.Root.Name.LocalName != "root")
            {
                reason = "resource .resx root element is not <root>";
                return null;
            }

            var result = new Dictionary<string, ResourceMeta>(StringComparer.Ordinal);
            var seen = new HashSet<string>(StringComparer.Ordinal);
            int count = 0;
            foreach (var data in doc.Root.Elements().Where(e => e.Name.LocalName == "data"))
            {
                if (++count > MaxResources)
                {
                    reason = "resource .resx has too many data nodes";
                    return null;
                }
                string name = ((string?)data.Attribute("name")) ?? "";
                if (name.Length == 0) continue;
                if (!seen.Add(name))
                {
                    reason = "resource .resx has duplicate key: " + name;
                    return null;
                }

                var meta = TryClassifyResourceNode(data);
                if (meta != null) result[name] = meta;
            }
            return result;
        }

        private static ResourceMeta? TryClassifyResourceNode(XElement data)
        {
            string typeName = NormalizeType(((string?)data.Attribute("type")) ?? "");
            string mime = ((string?)data.Attribute("mimetype")) ?? "";
            string value = data.Elements().FirstOrDefault(e => e.Name.LocalName == "value")?.Value ?? "";

            if (typeName == "System.Resources.ResXFileRef")
            {
                string[] parts = value.Split(';');
                if (parts.Length < 2 || string.IsNullOrWhiteSpace(parts[0])) return null;
                string fileRefType = NormalizeType(parts[1]);
                return ImageTypes.Contains(fileRefType)
                    ? new ResourceMeta { ValueTypeName = fileRefType, StorageKind = "fileRef" }
                    : null;
            }

            if (mime.IndexOf("bytearray.base64", StringComparison.OrdinalIgnoreCase) >= 0
                && ImageTypes.Contains(typeName)
                && LooksLikeBoundedBase64(value))
            {
                return new ResourceMeta { ValueTypeName = typeName, StorageKind = "bytearray" };
            }

            return null;
        }

        private static bool LooksLikeBoundedBase64(string value)
        {
            string compact = new(value.Where(c => !char.IsWhiteSpace(c)).ToArray());
            if (compact.Length == 0 || compact.Length > MaxTextChars) return false;
            try
            {
                _ = Convert.FromBase64String(compact);
                return true;
            }
            catch { return false; }
        }

        private static List<GeneratedResourceProperty>? ParseGeneratedProperties(string source, out string reason)
        {
            reason = "";
            var tree = CSharpSyntaxTree.ParseText(source);
            var diagnostics = tree.GetDiagnostics().Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
            if (diagnostics.Count > 0)
            {
                reason = "resource designer source has syntax errors";
                return null;
            }

            var root = tree.GetRoot();
            var properties = new List<GeneratedResourceProperty>();
            foreach (var prop in root.DescendantNodes().OfType<PropertyDeclarationSyntax>())
            {
                if (!prop.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword))) continue;

                string valueType = NormalizeType(prop.Type.ToString());
                if (!ImageTypes.Contains(valueType)) continue;
                if (!DesignerControlEditor.IsValidIdentifier(prop.Identifier.Text)) continue;

                string? key = ExtractCanonicalGetObjectKey(prop);
                if (string.IsNullOrEmpty(key)) continue;

                var cls = prop.FirstAncestorOrSelf<ClassDeclarationSyntax>();
                if (cls == null) continue;
                if (!IsCanonicalGeneratedResourceClass(cls)) continue;
                string className = cls.Identifier.Text;
                string classFqn = QualifiedClassName(cls);
                if (!IsValidQualifiedName(classFqn)) continue;

                properties.Add(new GeneratedResourceProperty
                {
                    Key = key,
                    PropertyName = prop.Identifier.Text,
                    ResourceClassName = className,
                    ResourceClassFullName = classFqn,
                    ValueTypeName = valueType,
                });
            }

            if (properties.Count == 0)
            {
                reason = "resource designer source has no strongly typed image/icon properties";
                return null;
            }

            if (properties.GroupBy(p => p.ResourceClassFullName + "." + p.PropertyName, StringComparer.Ordinal).Any(g => g.Count() > 1))
            {
                reason = "resource designer source has duplicate generated properties";
                return null;
            }
            if (properties.GroupBy(p => p.Key, StringComparer.Ordinal).Any(g => g.Count() > 1))
            {
                reason = "resource designer source maps one resource key to multiple image/icon properties";
                return null;
            }

            return properties;
        }

        /// <summary>
        /// Static access initializes the containing type before it invokes an otherwise-safe image property getter.
        /// Therefore the whole generated resource-class boundary must be inert and canonical, not only the candidate
        /// property body. We accept the shape emitted by the Visual Studio strongly-typed resource generator and reject
        /// partial/base classes, type initializers, static member initializers, or a substituted ResourceManager getter.
        /// </summary>
        private static bool IsCanonicalGeneratedResourceClass(ClassDeclarationSyntax cls)
        {
            if (cls.Modifiers.Any(m => m.IsKind(SyntaxKind.PartialKeyword))
                || cls.BaseList != null
                || cls.TypeParameterList != null)
                return false;

            foreach (var member in cls.Members)
            {
                if (member is ConstructorDeclarationSyntax ctor
                    && ctor.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword)))
                    return false;
                if (member is FieldDeclarationSyntax field
                    && field.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword))
                    && field.Declaration.Variables.Any(v => v.Initializer != null))
                    return false;
                if (member is EventFieldDeclarationSyntax eventField
                    && eventField.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword))
                    && eventField.Declaration.Variables.Any(v => v.Initializer != null))
                    return false;
                if (member is PropertyDeclarationSyntax property
                    && property.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword))
                    && property.Initializer != null)
                    return false;
            }

            if (!HasCanonicalStaticField(cls, "resourceMan", "System.Resources.ResourceManager")
                || !HasCanonicalStaticField(cls, "resourceCulture", "System.Globalization.CultureInfo"))
                return false;

            var resourceManagers = cls.Members.OfType<PropertyDeclarationSyntax>()
                .Where(p => p.Identifier.Text == "ResourceManager").ToList();
            return resourceManagers.Count == 1 && IsCanonicalResourceManagerProperty(resourceManagers[0], cls.Identifier.Text);
        }

        private static bool HasCanonicalStaticField(ClassDeclarationSyntax cls, string name, string typeName)
        {
            var matches = cls.Members.OfType<FieldDeclarationSyntax>()
                .Where(f => f.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword))
                    && NormalizeType(f.Declaration.Type.ToString()) == typeName)
                .SelectMany(f => f.Declaration.Variables)
                .Where(v => v.Identifier.Text == name)
                .ToList();
            return matches.Count == 1 && matches[0].Initializer == null;
        }

        private static bool IsCanonicalResourceManagerProperty(PropertyDeclarationSyntax prop, string className)
        {
            if (!prop.Modifiers.Any(m => m.IsKind(SyntaxKind.StaticKeyword))
                || NormalizeType(prop.Type.ToString()) != "System.Resources.ResourceManager"
                || prop.ExpressionBody != null
                || prop.AccessorList == null
                || prop.AccessorList.Accessors.Count != 1)
                return false;
            var getter = prop.AccessorList.Accessors[0];
            if (!getter.IsKind(SyntaxKind.GetAccessorDeclaration)
                || getter.Body == null
                || getter.ExpressionBody != null
                || getter.Body.Statements.Count != 2
                || getter.Body.Statements[0] is not IfStatementSyntax ifStatement
                || getter.Body.Statements[1] is not ReturnStatementSyntax returned
                || UnwrapParentheses(returned.Expression) is not IdentifierNameSyntax returnedId
                || returnedId.Identifier.Text != "resourceMan")
                return false;

            if (UnwrapParentheses(ifStatement.Condition) is not InvocationExpressionSyntax conditionCall
                || conditionCall.Expression is not MemberAccessExpressionSyntax conditionMember
                || conditionMember.Name.Identifier.Text != "ReferenceEquals"
                || !IsSystemObjectReceiver(conditionMember.Expression.ToString())
                || conditionCall.ArgumentList.Arguments.Count != 2
                || UnwrapParentheses(conditionCall.ArgumentList.Arguments[0].Expression) is not IdentifierNameSyntax fieldArg
                || fieldArg.Identifier.Text != "resourceMan"
                || !UnwrapParentheses(conditionCall.ArgumentList.Arguments[1].Expression)!.IsKind(SyntaxKind.NullLiteralExpression))
                return false;

            if (ifStatement.Statement is not BlockSyntax block
                || block.Statements.Count != 2
                || block.Statements[0] is not LocalDeclarationStatementSyntax local
                || block.Statements[1] is not ExpressionStatementSyntax assignmentStatement
                || local.Declaration.Variables.Count != 1
                || NormalizeType(local.Declaration.Type.ToString()) != "System.Resources.ResourceManager")
                return false;
            var temp = local.Declaration.Variables[0];
            if (temp.Initializer?.Value is not ObjectCreationExpressionSyntax creation
                || NormalizeType(creation.Type.ToString()) != "System.Resources.ResourceManager"
                || creation.ArgumentList?.Arguments.Count != 2
                || creation.ArgumentList.Arguments[0].Expression is not LiteralExpressionSyntax baseName
                || !baseName.IsKind(SyntaxKind.StringLiteralExpression)
                || !IsCanonicalResourceAssemblyExpression(creation.ArgumentList.Arguments[1].Expression, className))
                return false;

            if (assignmentStatement.Expression is not AssignmentExpressionSyntax assignment
                || !assignment.IsKind(SyntaxKind.SimpleAssignmentExpression)
                || UnwrapParentheses(assignment.Left) is not IdentifierNameSyntax assignedField
                || assignedField.Identifier.Text != "resourceMan"
                || UnwrapParentheses(assignment.Right) is not IdentifierNameSyntax assignedTemp
                || assignedTemp.Identifier.Text != temp.Identifier.Text)
                return false;
            return true;
        }

        private static bool IsSystemObjectReceiver(string receiver) =>
            receiver == "object" || receiver == "System.Object" || receiver == "global::System.Object";

        private static bool IsCanonicalResourceAssemblyExpression(ExpressionSyntax expression, string className)
        {
            expression = UnwrapParentheses(expression)!;
            if (expression is not MemberAccessExpressionSyntax assembly
                || assembly.Name.Identifier.Text != "Assembly"
                || UnwrapParentheses(assembly.Expression) is not TypeOfExpressionSyntax typeOf)
                return false;
            string typeName = NormalizeType(typeOf.Type.ToString());
            return typeName == className || typeName.EndsWith("." + className, StringComparison.Ordinal);
        }

        /// <summary>
        /// Accept only the two canonical strongly-typed resource getter shapes: the Visual Studio generator's
        /// object-local followed by a typed return, or a direct typed return. In both cases the only invocation is
        /// exactly ResourceManager.GetObject("key", resourceCulture). Merely finding a method named GetObject anywhere
        /// in a property is not sufficient: that would let an arbitrary project getter with side effects masquerade as
        /// a generated resource accessor and later execute when the assigned designer expression is evaluated.
        /// </summary>
        private static string? ExtractCanonicalGetObjectKey(PropertyDeclarationSyntax prop)
        {
            if (prop.ExpressionBody != null || prop.AccessorList == null || prop.AccessorList.Accessors.Count != 1)
                return null;
            var getter = prop.AccessorList.Accessors[0];
            if (!getter.IsKind(SyntaxKind.GetAccessorDeclaration) || getter.Body == null || getter.ExpressionBody != null)
                return null;

            var statements = getter.Body.Statements;
            if (statements.Count == 1 && statements[0] is ReturnStatementSyntax directReturn)
            {
                return ExtractTypedResourceReturn(directReturn.Expression, prop.Type, expectedLocal: null);
            }

            if (statements.Count != 2
                || statements[0] is not LocalDeclarationStatementSyntax local
                || statements[1] is not ReturnStatementSyntax returned
                || local.Declaration.Variables.Count != 1)
                return null;

            string localType = NormalizeType(local.Declaration.Type.ToString());
            if (localType != "object" && localType != "System.Object") return null;
            var variable = local.Declaration.Variables[0];
            if (variable.Initializer == null) return null;
            string? key = ExtractCanonicalGetObjectInvocation(variable.Initializer.Value);
            if (key == null) return null;

            string? returnedKey = ExtractTypedResourceReturn(returned.Expression, prop.Type, variable.Identifier.Text);
            return returnedKey == "#local#" ? key : null;
        }

        private static string? ExtractTypedResourceReturn(ExpressionSyntax? expression, TypeSyntax propertyType, string? expectedLocal)
        {
            expression = UnwrapParentheses(expression);
            if (expression is not CastExpressionSyntax cast
                || NormalizeType(cast.Type.ToString()) != NormalizeType(propertyType.ToString()))
                return null;

            ExpressionSyntax? value = UnwrapParentheses(cast.Expression);
            if (expectedLocal != null)
                return value is IdentifierNameSyntax id && id.Identifier.Text == expectedLocal ? "#local#" : null;
            return ExtractCanonicalGetObjectInvocation(value);
        }

        private static string? ExtractCanonicalGetObjectInvocation(ExpressionSyntax? expression)
        {
            expression = UnwrapParentheses(expression);
            if (expression is not InvocationExpressionSyntax inv
                || inv.Expression is not MemberAccessExpressionSyntax member
                || member.Name.Identifier.Text != "GetObject"
                || UnwrapParentheses(member.Expression) is not IdentifierNameSyntax receiver
                || receiver.Identifier.Text != "ResourceManager"
                || inv.ArgumentList.Arguments.Count != 2)
                return null;

            var keyArg = inv.ArgumentList.Arguments[0];
            var cultureArg = inv.ArgumentList.Arguments[1];
            if (keyArg.NameColon != null || cultureArg.NameColon != null
                || !keyArg.RefKindKeyword.IsKind(SyntaxKind.None)
                || !cultureArg.RefKindKeyword.IsKind(SyntaxKind.None)
                || keyArg.Expression is not LiteralExpressionSyntax keyLiteral
                || !keyLiteral.IsKind(SyntaxKind.StringLiteralExpression)
                || UnwrapParentheses(cultureArg.Expression) is not IdentifierNameSyntax culture
                || culture.Identifier.Text != "resourceCulture")
                return null;
            return keyLiteral.Token.ValueText;
        }

        private static ExpressionSyntax? UnwrapParentheses(ExpressionSyntax? expression)
        {
            while (expression is ParenthesizedExpressionSyntax paren) expression = paren.Expression;
            return expression;
        }

        private static string QualifiedClassName(ClassDeclarationSyntax cls)
        {
            var names = new Stack<string>();
            names.Push(cls.Identifier.Text);
            for (SyntaxNode? node = cls.Parent; node != null; node = node.Parent)
            {
                switch (node)
                {
                    case ClassDeclarationSyntax parentClass:
                        names.Push(parentClass.Identifier.Text);
                        break;
                    case BaseNamespaceDeclarationSyntax ns:
                        names.Push(ns.Name.ToString());
                        break;
                }
            }
            return string.Join(".", names);
        }

        private static string NormalizeType(string typeName)
        {
            string t = (typeName ?? "").Trim();
            if (t.StartsWith("global::", StringComparison.Ordinal)) t = t.Substring("global::".Length);
            int comma = t.IndexOf(',');
            if (comma >= 0) t = t.Substring(0, comma);
            t = t.Trim();
            while (t.EndsWith("?", StringComparison.Ordinal)) t = t.Substring(0, t.Length - 1);
            return t;
        }

        private static bool TypesCompatible(string resxType, string generatedType)
        {
            resxType = NormalizeType(resxType);
            generatedType = NormalizeType(generatedType);
            return resxType == generatedType
                || (generatedType == "System.Drawing.Image" && resxType == "System.Drawing.Bitmap");
        }

        private static bool TypesAssignableToTarget(string resourceType, string targetType)
        {
            resourceType = NormalizeType(resourceType);
            targetType = NormalizeType(targetType);
            return targetType == resourceType
                || (targetType == "System.Drawing.Image" && resourceType == "System.Drawing.Bitmap");
        }

        private static bool IsValidQualifiedName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return false;
            return name.Split('.').All(DesignerControlEditor.IsValidIdentifier);
        }

        private static bool IsSafeGeneratedExpression(string expr, string classFqn, string propertyName)
        {
            var parsed = SyntaxFactory.ParseExpression(expr);
            if (parsed.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error)) return false;
            if (parsed.ToString() != expr) return false;
            return expr == "global::" + classFqn + "." + propertyName;
        }
    }
}
