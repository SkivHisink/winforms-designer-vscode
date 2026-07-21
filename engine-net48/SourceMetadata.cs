using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using WinFormsDesigner.Engine;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Parses a compiled control's .Designer.cs (pure Roslyn — no instantiation, so it works for DevExpress/any
    /// library the render domain can't load) to recover the two facts the LIVE TypeDescriptor describe can't see:
    /// which properties were assigned in source (the grid's "set in source" bold) and which event handlers were
    /// wired (the Events tab). Runs in the HOST domain (like <see cref="RootTypeResolver"/>, keeping Roslyn out of
    /// the render child domain): <see cref="Apply"/> post-processes the marshaled <see cref="ComponentDesc"/>.
    /// This is the net48 counterpart of the net9 engine's interpret-time explicitMembers + ExtractEventWirings.
    /// </summary>
    public static class SourceMetadata
    {
        /// <summary>Set <c>SourceExplicit</c> on properties assigned in source and <c>Handler</c> on wired events for
        /// the component <c>desc.Id</c> ("this" = root, else the .Designer.cs field name). Best-effort: a missing or
        /// unparsable file (or any failure) leaves the describe's defaults (false / null) untouched.
        /// <paramref name="overrideSource"/>, when non-null, is parsed INSTEAD of the on-disk file — the host passes the
        /// UNSAVED .Designer.cs buffer so a just-wired event / just-reset property reflects the dirty edit immediately,
        /// not the stale persisted file (a newly wired event would otherwise show unwired, a reset prop stay bold).</summary>
        public static void Apply(ComponentDesc? desc, string? designerFilePath, string? overrideSource = null)
        {
            if (desc == null) return;
            string? code = overrideSource;
            if (code == null)
            {
                if (string.IsNullOrEmpty(designerFilePath) || !File.Exists(designerFilePath)) return;
                code = File.ReadAllText(designerFilePath);
            }
            try
            {
                var (explicitProps, handlers) = Parse(code, desc.Id);
                if (desc.Properties != null)
                    foreach (var p in desc.Properties)
                        if (p != null && explicitProps.Contains(p.Name)) p.SourceExplicit = true;
                if (desc.Events != null)
                    foreach (var e in desc.Events)
                        if (e != null && handlers.TryGetValue(e.Name, out var h)) e.Handler = h;
                InjectDesignTimeProperties(desc, code);
            }
            catch { /* best effort — leave the live-describe defaults */ }
        }

        /// <summary>Headless test hook (pure text, no assembly): the explicit props + event→handler wirings parsed
        /// for <paramref name="id"/> in <paramref name="designerFilePath"/>. Used by the <c>--parse-meta</c> CLI.</summary>
        private static void InjectDesignTimeProperties(ComponentDesc desc, string code)
        {
            if (desc.IsRoot || desc.IsToolStripItem || string.IsNullOrEmpty(desc.Id) || desc.Properties == null) return;
            bool hasRealModifiers = desc.Properties.Any(p => p != null && p.Name == "Modifiers");
            bool hasRealGenerateMember = desc.Properties.Any(p => p != null && p.Name == "GenerateMember");
            var fields = DesignerModifiers.ParseFieldModifiers(code);
            bool hasField = fields.TryGetValue(desc.Id, out var field);

            if (!hasRealGenerateMember)
            {
                desc.Properties.Add(new PropertyDesc
                {
                    Name = "GenerateMember",
                    Type = "System.Boolean",
                    Value = hasField ? "true" : "false",
                    ReadOnly = true,
                    Category = "Design",
                    Description = "Whether the designer generates a member (field) for this component. Read-only preview.",
                    StandardValues = new List<string> { "true", "false" },
                    StandardValuesExclusive = true,
                    DesignTime = true,
                });
            }
            if (!hasRealModifiers)
            {
                desc.Properties.Add(new PropertyDesc
                {
                    Name = "Modifiers",
                    Type = "System.String",
                    Value = hasField ? field.Display : "Private",
                    ReadOnly = !hasField || !field.Editable,
                    Category = "Design",
                    Description = "Indicates the visibility level of the object's generated member (field).",
                    StandardValues = DesignerModifiers.DisplayNames,
                    StandardValuesExclusive = true,
                    DesignTime = true,
                });
            }
            desc.Properties.Sort((a, b) => string.CompareOrdinal(a?.Name, b?.Name));
        }

        public static (List<string> explicitProps, List<KeyValuePair<string, string>> handlers) Dump(string designerFilePath, string id)
        {
            var (props, handlers) = Parse(File.ReadAllText(designerFilePath), id);
            return (props.OrderBy(s => s, StringComparer.Ordinal).ToList(), handlers.OrderBy(kv => kv.Key, StringComparer.Ordinal).ToList());
        }

        /// <summary>For component <paramref name="id"/>: the set of assigned property names (the FIRST hop after the
        /// owner — <c>this.&lt;id&gt;.&lt;prop&gt; = …</c> and nested <c>this.&lt;id&gt;.&lt;prop&gt;.X = …</c> both record
        /// <c>prop</c>, matching net9) and the event→handler wirings (<c>this.&lt;id&gt;.&lt;evt&gt; += …</c>) found in
        /// InitializeComponent.</summary>
        private static (HashSet<string> explicitProps, Dictionary<string, string> handlers) Parse(string code, string id)
        {
            var props = new HashSet<string>(StringComparer.Ordinal);
            var handlers = new Dictionary<string, string>(StringComparer.Ordinal);

            var root = CSharpSyntaxTree.ParseText(code).GetRoot();
            // Parse the SAME class the live describe instantiates — guaranteed, not merely intended: both go through
            // the one shared resolver (RootTypeResolver.Resolve does too). This used to mirror that resolver's
            // "first class in the file" rule by hand, so a helper class ahead of the form decorated the wrong grid.
            var cls = FormClassResolver.FormClass(root);
            var init = FormClassResolver.InitMethodOf(cls);
            if (cls == null || init?.Body == null) return (props, handlers);

            // field names, so a `this.<field> = new …` field CONSTRUCTION isn't mistaken for a root property set (a
            // one-segment `this.<X> =` is either a real root prop or a child-field construction — the latter is a
            // field). Across ALL the form's partials — a form may split its fields into a separate partial, and
            // scanning only the IC-bearing one then mis-reads every field construction as a root property set.
            var fields = FormClassResolver.FieldNamesOf(cls);

            foreach (var stmt in init.Body.Statements)
            {
                if (stmt is not ExpressionStatementSyntax es || es.Expression is not AssignmentExpressionSyntax asg) continue;
                if (asg.Left is not MemberAccessExpressionSyntax lhs) continue;
                var (owner, member) = OwnerAndMember(lhs);
                if (owner == null || owner != id) continue;

                if (asg.OperatorToken.IsKind(SyntaxKind.PlusEqualsToken))
                {
                    var h = ExtractHandlerName(asg.Right);
                    if (h != null) handlers[member] = h;
                }
                else if (asg.OperatorToken.IsKind(SyntaxKind.EqualsToken))
                {
                    // a one-segment `this.<field> = new …()` is a child-field CONSTRUCTION, not a root property set
                    // (mirrors net9's ObjectCreation-only construction branch); a literal/other RHS to a field-named
                    // root property, or a root event `+=` (handled above), IS a genuine set and must be recorded.
                    if (owner == "this" && fields.Contains(member) && asg.Right is ObjectCreationExpressionSyntax) continue;
                    props.Add(member);
                }
            }
            return (props, handlers);
        }

        /// <summary>The owning component id + the FIRST member hop after it, for an assignment LHS of any depth —
        /// mirroring the net9 engine's Flatten + HandleAssignment(chain[propStart]): <c>this.&lt;member&gt;</c> →
        /// ("this", member); <c>this.&lt;id&gt;.&lt;X&gt;[.&lt;Y&gt;…]</c> or bare <c>&lt;id&gt;.&lt;X&gt;[.…]</c> →
        /// (id, X) so a nested sub-object set like <c>this.grid.Appearance.Font = …</c> records ("grid","Appearance")
        /// and bolds the Appearance row (the common DevExpress idiom). An unrecognized receiver (cast, invocation, …)
        /// yields a "?" sentinel → (null, …) so it's skipped, exactly as net9 drops its phantom chain key.</summary>
        private static (string? owner, string member) OwnerAndMember(MemberAccessExpressionSyntax lhs)
        {
            var chain = new List<string>();
            void Walk(ExpressionSyntax e)
            {
                switch (e)
                {
                    case MemberAccessExpressionSyntax m: Walk(m.Expression); chain.Add(m.Name.Identifier.Text); break;
                    case IdentifierNameSyntax idn: chain.Add(idn.Identifier.Text); break;
                    case ThisExpressionSyntax: break;                 // contributes nothing (mirrors net9 Flatten)
                    case ParenthesizedExpressionSyntax p: Walk(p.Expression); break;
                    default: chain.Add("?"); break;                  // unknown receiver — won't match a real id
                }
            }
            Walk(lhs);
            if (chain.Count == 0 || chain.Contains("?")) return (null, lhs.Name.Identifier.Text);
            if (chain.Count == 1) return ("this", chain[0]);         // this.<member>  (root direct)
            return (chain[0], chain[1]);                             // <id>.<firstHop>[.…]  →  (id, firstHop)
        }

        /// <summary>Handler method name from the RHS of an event wiring: <c>new EventHandler(this.M)</c>,
        /// <c>this.M</c>, or a bare <c>M</c> → "M"; null if not a recognizable method reference. (Mirrors the net9
        /// engine's ExtractHandlerName.)</summary>
        private static string? ExtractHandlerName(ExpressionSyntax rhs)
        {
            ExpressionSyntax e = rhs;
            if (e is ObjectCreationExpressionSyntax oce && oce.ArgumentList is { Arguments: { Count: > 0 } } al)
                e = al.Arguments[0].Expression;
            return e switch
            {
                MemberAccessExpressionSyntax ma => ma.Name.Identifier.Text,
                IdentifierNameSyntax id => id.Identifier.Text,
                _ => null,
            };
        }
    }
}
