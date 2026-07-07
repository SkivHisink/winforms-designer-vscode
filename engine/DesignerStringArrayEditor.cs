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
    /// Read/build side of the generic <c>string[]</c> property editor — the VS "String Collection Editor" shape
    /// applied to a plain array PROPERTY. The flagship target is <c>TextBox.Lines</c> / <c>RichTextBox.Lines</c>,
    /// which is a COMPUTED property: its getter is <c>Text.Split</c> and its setter is <c>Text = Join</c>, and it
    /// carries <c>[DesignerSerializationVisibility(Hidden)]</c> — so VS (and most hand-written code) serialize the
    /// multi-line content as <c>this.notesBox.Text = "a\r\nb";</c>, NOT as a <c>Lines =</c> assignment.
    ///
    /// Therefore this editor keys off the RUNTIME-EFFECTIVE assignment: for a content-backed property (Lines→Text)
    /// it reads/writes whichever of <c>owner.Lines = new[]{…}</c> / <c>owner.Text = "…"</c> is LAST in source (the
    /// one that wins at runtime), IN THAT ASSIGNMENT'S OWN REPRESENTATION. That way an edit never introduces a
    /// second, competing assignment that the other would silently override (which was a real data-loss bug: writing
    /// <c>Lines =</c> after an existing <c>Text =</c> discarded the author's text). A genuine (non-content-backed)
    /// <c>string[]</c> property is edited directly as <c>owner.prop = new string[]{…}</c>.
    ///
    /// Item strings are emitted through <see cref="SyntaxFactory.Literal(string)"/> (correct escaping, no expression
    /// can be injected); the read side returns Ok=false (read-only) whenever the effective value isn't a plain
    /// literal (bound/computed/resx-backed) so nothing non-literal is ever silently overwritten, and for a
    /// RichTextBox whose content is stored as <c>Rtf</c> (formatting this plain-text editor can't represent).
    /// </summary>
    public static class DesignerStringArrayEditor
    {
        /// <summary>A computed string[] property whose value is really stored in a sibling STRING property
        /// (Lines getter=Text.Split / setter=Text=Join). Editing routes to that backing property.</summary>
        private static readonly Dictionary<string, string> ContentBackedBy = new(StringComparer.Ordinal)
        {
            ["Lines"] = "Text",
        };

        /// <summary>A companion property that, when assigned, carries content this plain-text editor cannot
        /// represent (RichTextBox.Rtf holds formatting) — its presence forces the property read-only so an edit
        /// can't discard the rich content.</summary>
        private static readonly Dictionary<string, string> BlockedByCompanion = new(StringComparer.Ordinal)
        {
            ["Lines"] = "Rtf",
        };

        // ---- read ----

        /// <summary>The current items of the RUNTIME-EFFECTIVE assignment (the LAST of <c>owner.prop = new[]{…}</c> /
        /// <c>owner.&lt;backing&gt; = "…"</c>), in source order. <see cref="CollectionItemsResult.Ok"/> is false when
        /// the effective value isn't a plain string literal (bound/computed/resx) or a RichTextBox stores its content
        /// as Rtf — the webview keeps the field read-only rather than risk losing it. No assignment → editable-empty.</summary>
        public static CollectionItemsResult ListArray(string sourceText, string ownerId, string prop)
        {
            if (!IsIdentifier(ownerId)) return new CollectionItemsResult { Ok = false, Reason = "invalid owner id: " + ownerId };
            if (!IsIdentifier(prop)) return new CollectionItemsResult { Ok = false, Reason = "invalid property name: " + prop };

            var init = FindInitializeComponent(CSharpSyntaxTree.ParseText(sourceText).GetRoot());
            if (init?.Body == null) return new CollectionItemsResult { Ok = false, Reason = "InitializeComponent not found" };

            // rich content we can't represent as plain lines (RichTextBox.Rtf) → read-only, so an edit can't discard it
            if (BlockedByCompanion.TryGetValue(prop, out var blocker) && HasAssignment(init, ownerId, blocker))
                return new CollectionItemsResult { Ok = false, Reason = ownerId + " content is stored as " + blocker + " (rich text) — plain-text editing not supported" };

            string? backing = ContentBackedBy.TryGetValue(prop, out var b) ? b : null;
            var eff = LastEffectiveAssignment(init, ownerId, prop, backing);
            // no explicit assignment → default (empty array) → offer an empty, editable list
            if (eff == null) return new CollectionItemsResult { Ok = true, Items = new List<string>() };

            if (eff.Value.isBacking)
            {
                // string content assignment (owner.Text = "…") → split into lines
                if (!TryStringLiteral(eff.Value.asg.Right, out var s))
                    return new CollectionItemsResult { Ok = false, Reason = "non-literal " + backing + " value on " + ownerId };
                return new CollectionItemsResult { Ok = true, Items = SplitLines(s!) };
            }

            // array assignment (owner.prop = new[]{…}) → the literal elements
            var elems = ArrayElements(eff.Value.asg.Right);
            if (elems == null)
                return new CollectionItemsResult { Ok = false, Reason = "value is not an array initializer: " + ownerId + "." + prop };
            var items = new List<string>();
            foreach (var el in elems)
            {
                if (!TryStringLiteral(el, out var v))
                    return new CollectionItemsResult { Ok = false, Reason = "non-literal element in " + ownerId + "." + prop };
                items.Add(v!);
            }
            return new CollectionItemsResult { Ok = true, Items = items };
        }

        // ---- write resolution + build ----

        /// <summary>Decide which property + representation an edit targets, so it rewrites the runtime-effective
        /// assignment in place (never introducing a competing one): for a content-backed property, write the array
        /// form only if an existing <c>Lines =</c> array is already the effective assignment, otherwise write the
        /// backing content property (<c>Text = "…"</c>); a genuine string[] property is always the array form.</summary>
        public static (string targetProp, bool asArray) ResolveWriteTarget(string sourceText, string ownerId, string prop)
        {
            var init = FindInitializeComponent(CSharpSyntaxTree.ParseText(sourceText).GetRoot());
            string? backing = ContentBackedBy.TryGetValue(prop, out var b) ? b : null;
            if (backing == null) return (prop, true); // genuine string[] property → direct array assignment
            var eff = init?.Body != null ? LastEffectiveAssignment(init, ownerId, prop, backing) : null;
            // an existing `owner.Lines = new[]{…}` array is the effective value → keep editing it as an array;
            // otherwise (content in Text, or nothing yet) write the backing content property as a joined string.
            if (eff != null && !eff.Value.isBacking) return (prop, true);
            return (backing, false);
        }

        /// <summary>The canonical single-line array right-hand side for <paramref name="items"/>:
        /// <c>new string[] { "a", "b" }</c> (or <c>new string[] { }</c> when empty). Single line is mandatory —
        /// <see cref="DesignerPropertyEditor.IsSingleExpression"/> requires the emitted expression to round-trip to
        /// itself. Elements are escaped via <see cref="SyntaxFactory.Literal(string)"/>.</summary>
        public static string BuildArrayExpr(IReadOnlyList<string> items)
        {
            if (items.Count == 0) return "new string[] { }";
            var sb = new StringBuilder("new string[] { ");
            for (int i = 0; i < items.Count; i++)
            {
                sb.Append(SyntaxFactory.Literal(items[i] ?? "").ToString());
                if (i < items.Count - 1) sb.Append(", ");
            }
            sb.Append(" }");
            return sb.ToString();
        }

        /// <summary>The escaped string-literal right-hand side that stores <paramref name="items"/> as the joined
        /// content of a content-backed property (<c>Text = "a\r\nb"</c>). Newlines are CRLF (the WinForms default).
        /// A single escaped literal, so it satisfies the single-expression gate and injects nothing.</summary>
        public static string BuildTextLiteral(IReadOnlyList<string> items)
        {
            return SyntaxFactory.Literal(string.Join("\r\n", items)).ToString();
        }

        // ---- helpers (kept local so the proven DesignerPropertyEditor stays untouched) ----

        /// <summary>The LAST (runtime-effective) assignment among <c>owner.prop = …</c> (isBacking=false) and, when
        /// <paramref name="backing"/> is set, <c>owner.&lt;backing&gt; = …</c> (isBacking=true), or null if none.</summary>
        private static (AssignmentExpressionSyntax asg, bool isBacking)? LastEffectiveAssignment(
            MethodDeclarationSyntax init, string ownerId, string prop, string? backing)
        {
            (AssignmentExpressionSyntax, bool)? last = null;
            foreach (var st in init.Body!.Statements)
            {
                if (st is not ExpressionStatementSyntax es || es.Expression is not AssignmentExpressionSyntax asg) continue;
                var chain = Flatten(asg.Left);
                if (chain.Count != 2 || chain[0] != ownerId) continue;
                if (chain[1] == prop) last = (asg, false);
                else if (backing != null && chain[1] == backing) last = (asg, true);
            }
            return last;
        }

        private static bool HasAssignment(MethodDeclarationSyntax init, string ownerId, string propName)
        {
            foreach (var st in init.Body!.Statements)
            {
                if (st is ExpressionStatementSyntax { Expression: AssignmentExpressionSyntax asg })
                {
                    var chain = Flatten(asg.Left);
                    if (chain.Count == 2 && chain[0] == ownerId && chain[1] == propName) return true;
                }
            }
            return false;
        }

        /// <summary>Split a joined content string into lines — the inverse of the CRLF join used by
        /// <see cref="BuildTextLiteral"/>. An empty string is zero lines (matching TextBox.Lines for empty Text).</summary>
        private static List<string> SplitLines(string s) =>
            s.Length == 0 ? new List<string>() : s.Split(new[] { "\r\n", "\r", "\n" }, StringSplitOptions.None).ToList();

        private static IReadOnlyList<ExpressionSyntax>? ArrayElements(ExpressionSyntax? arg)
        {
            InitializerExpressionSyntax? init = arg switch
            {
                ArrayCreationExpressionSyntax ac => ac.Initializer,
                ImplicitArrayCreationExpressionSyntax iac => iac.Initializer,
                InitializerExpressionSyntax ie => ie,
                _ => null,
            };
            return init?.Expressions.ToList();
        }

        private static bool TryStringLiteral(ExpressionSyntax expr, out string? value)
        {
            if (expr is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
            {
                value = lit.Token.ValueText;
                return true;
            }
            value = null;
            return false;
        }

        private static bool IsIdentifier(string s) => !string.IsNullOrEmpty(s) && SyntaxFacts.IsValidIdentifier(s);

        private static MethodDeclarationSyntax? FindInitializeComponent(SyntaxNode root)
        {
            foreach (var cls in root.DescendantNodes().OfType<ClassDeclarationSyntax>())
            {
                var m = cls.Members.OfType<MethodDeclarationSyntax>().FirstOrDefault(x => x.Identifier.Text == "InitializeComponent");
                if (m != null) return m;
            }
            return null;
        }

        private static List<string> Flatten(ExpressionSyntax expr)
        {
            var names = new List<string>();
            void Walk(ExpressionSyntax e)
            {
                switch (e)
                {
                    case MemberAccessExpressionSyntax m: Walk(m.Expression); names.Add(m.Name.Identifier.Text); break;
                    case ThisExpressionSyntax: break;
                    case IdentifierNameSyntax id: names.Add(id.Identifier.Text); break;
                    case ParenthesizedExpressionSyntax p: Walk(p.Expression); break;
                    default: names.Add("?" + e.Kind()); break;
                }
            }
            Walk(expr);
            return names;
        }
    }
}
