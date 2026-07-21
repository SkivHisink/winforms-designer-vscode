using System;
using System.CodeDom;
using System.CodeDom.Compiler;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design;
using System.ComponentModel.Design.Serialization;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using Microsoft.CSharp;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    public sealed class RoundTripResult
    {
        /// <summary>Normalized InitializeComponent C# (the value written back to disk).</summary>
        public string Code { get; init; } = "";
        /// <summary>Raw serializer output before normalization (diagnostics).</summary>
        public string RawCode { get; init; } = "";
        public string ClassName { get; init; } = "";
        /// <summary>Default-valued property assignments dropped by normalization (e.g. "okButton.Enabled = True").</summary>
        public List<string> DroppedDefaults { get; init; } = new();
        public int DefaultsDropped => DroppedDefaults.Count;

        // ---- round-trip safety (safe-save gate): the save direction must NEVER silently drop user code ----
        public int TotalStatements { get; init; }
        public int Representable { get; init; }
        /// <summary>Source statements the interpreter could not represent (e.g. unresolved control types, hand-edits).</summary>
        public List<string> Unrepresentable { get; init; } = new();
        /// <summary>
        /// True only when the whole source was interpreted. If false, re-serializing would
        /// silently lose the unrepresentable constructs → the caller must fall back to
        /// read-only and must NOT write this output back over the source.
        /// </summary>
        public bool RoundTripSafe => Unrepresentable.Count == 0;
    }

    /// <summary>
    /// Serializes a live designer graph back to a VS-dialect InitializeComponent via the
    /// designer's <see cref="TypeCodeDomSerializer"/> (spike S2a), then applies a
    /// default-value normalization pass.
    ///
    /// Why normalization is needed: the standalone DesignSurface host over-emits
    /// default-valued primitive properties (Enabled=true, Visible=true, TabIndex=0, …)
    /// that real Visual Studio omits via ShouldSerialize/DefaultValue filtering. That
    /// over-emission is the #1 source of round-trip merge noise.
    /// We drop, post-serialization, any primitive assignment whose value
    /// equals the property's default — taken from a <see cref="DefaultValueAttribute"/>
    /// when present, otherwise from a fresh reference instance of the component type.
    ///
    /// Only primitive literals are considered; object-creation values (new Point/Size/…)
    /// and enum/field references are always kept, so genuine state (Checked=true, a custom
    /// control's Value=85) is never lost.
    ///
    /// When the source's explicitly-set members are known (round-trip from a real file),
    /// a stronger pass runs instead: emit only properties that were present in the source.
    /// That additionally removes non-default state the live designer/runtime assigns by
    /// itself (auto TabIndex 1..N, the CheckState mirror of Checked, TabStop), which the
    /// default-value pass cannot catch because those values differ from the property default.
    /// </summary>
    public static class DesignerSerializer
    {
        /// <summary>Sentinel: the default value could not be determined → treat as "never equal" (keep).</summary>
        private static readonly object Unknown = new();

        public static RoundTripResult Serialize(DesignSurface surface, IDesignerHost host, string className,
            bool normalizeDefaults = true, HashSet<(IComponent, string)>? explicitMembers = null,
            IReadOnlyList<string>? eventWirings = null, IReadOnlyList<string>? supportInit = null)
        {
            var root = host.RootComponent;
            // SerializerServices (NOT the surface itself) so VsNameCreationService is visible ONLY here: it makes the
            // generated locals match VS (treeNode1, not treenode1) without letting the host's load path name or
            // validate real source components with it.
            var manager = new DesignerSerializationManager(new SerializerServices(surface));
            using (manager.CreateSession())
            {
                var serializer = (TypeCodeDomSerializer)manager.GetSerializer(root.GetType(), typeof(TypeCodeDomSerializer))!;
                var members = host.Container.Components
                    .Cast<IComponent>()
                    .Where(c => !ReferenceEquals(c, root))
                    .ToList();

                CodeTypeDeclaration ctd = serializer.Serialize(manager, root, members);
                ctd.Name = string.IsNullOrEmpty(className)
                    ? (root.Site?.Name is { Length: > 0 } sn ? sn : "DesignedType")
                    : className;

                // Re-emit the source's event wirings VERBATIM. The interpreter can't wire the code-behind handler
                // methods to the live surface components (they live in the other partial), so the CodeDom serializer
                // never produces the `this.X.Event += …` lines on its own — inject them so the round-trip preserves
                // them exactly instead of silently dropping user wiring. Appended after the serialized body
                // (order among wirings preserved); the save-splicer re-indents, and the safe-save gate is whitespace-
                // insensitive, so position doesn't matter for correctness.
                InjectEventWirings(ctd, eventWirings);

                // Re-emit the source's ISupportInitialize BeginInit/EndInit brackets VERBATIM. The standalone
                // DesignSurface serializer doesn't produce them on its own (unlike real VS), so without this a form
                // with any DataGridView/BindingSource/PictureBox/NumericUpDown/SplitContainer would fail the safe-save
                // gate and fall back to read-only. Positioned runtime-correctly (BeginInit before the first layout
                // suspend, EndInit before the last resume); the gate is whitespace/position-insensitive (0.12.0 R1).
                InjectSupportInit(ctd, supportInit);

                string rawCode = GenerateCode(ctd);

                var dropped = new List<string>();
                if (normalizeDefaults)
                {
                    Normalize(ctd, root, members, explicitMembers, dropped);
                }

                string code = normalizeDefaults ? GenerateCode(ctd) : rawCode;

                return new RoundTripResult
                {
                    Code = code,
                    RawCode = rawCode,
                    ClassName = ctd.Name,
                    DroppedDefaults = dropped,
                };
            }
        }

        /// <summary>Append the source's verbatim event-wiring statements (<c>this.X.Event += …</c>) to
        /// InitializeComponent as raw snippets, so the round-trip reproduces them exactly — the surface has no
        /// code-behind handler methods for the serializer to emit them from. No-op when there are none.</summary>
        private static void InjectEventWirings(CodeTypeDeclaration ctd, IReadOnlyList<string>? eventWirings)
        {
            if (eventWirings == null || eventWirings.Count == 0)
            {
                return;
            }
            var init = ctd.Members.OfType<CodeMemberMethod>().FirstOrDefault(m => m.Name == "InitializeComponent");
            if (init == null)
            {
                return;
            }
            foreach (var w in eventWirings)
            {
                init.Statements.Add(new CodeSnippetStatement(w));
            }
        }

        /// <summary>Re-emit the source's verbatim ISupportInitialize <c>BeginInit</c>/<c>EndInit</c> brackets so the
        /// round-trip reproduces them exactly — the standalone serializer doesn't produce them itself. BeginInit is
        /// placed before the first <c>SuspendLayout</c> and EndInit before the last <c>ResumeLayout</c>, matching the
        /// runtime order VS emits (init must bracket the property block). The safe-save gate is position-insensitive,
        /// so exact byte-position vs. VS isn't required; this keeps a hypothetical write-back runtime-correct.
        /// No-op when there are none.</summary>
        private static void InjectSupportInit(CodeTypeDeclaration ctd, IReadOnlyList<string>? supportInit)
        {
            if (supportInit == null || supportInit.Count == 0)
            {
                return;
            }
            var init = ctd.Members.OfType<CodeMemberMethod>().FirstOrDefault(m => m.Name == "InitializeComponent");
            if (init == null)
            {
                return;
            }

            // Classify each captured snippet by PARSING its outer invocation (BeginInit vs EndInit) and extracting the
            // initialized target — NOT by substring, so a receiver/argument that happens to contain ".BeginInit("/
            // ".EndInit(" can't put one statement in both lists and double-emit.
            var begins = new List<string>();
            var ends = new List<(string target, string stmt)>();
            foreach (var s in supportInit)
            {
                var info = ClassifyInitBracket(s);
                if (info == null) continue; // capture is gated to real brackets; be defensive
                if (info.Value.isBegin) begins.Add(s);
                else ends.Add((info.Value.target, s));
            }

            // EndInit(X) goes before X's OWN ResumeLayout — VS finalizes deferred init before the control's layout
            // resumes ("before the last ResumeLayout" reordered it after the control's resume). Fall back to
            // before the last ResumeLayout only when the target's own resume isn't emitted. Recompute the index each
            // time so a prior insert doesn't stale a later anchor.
            foreach (var (target, stmt) in ends)
            {
                int idx = ResumeIndexForTarget(init.Statements, target);
                if (idx < 0) idx = LastInvokeIndex(init.Statements, "ResumeLayout");
                if (idx < 0) idx = init.Statements.Count;
                init.Statements.Insert(idx, new CodeSnippetStatement(stmt));
            }

            // BeginInit goes before the first SuspendLayout (VS emits init brackets right after construction, before
            // the layout suspends). Insert in reverse at the same index to preserve source order.
            int suspendIdx = FirstInvokeIndex(init.Statements, "SuspendLayout");
            if (suspendIdx < 0) suspendIdx = 0;
            for (int i = begins.Count - 1; i >= 0; i--)
            {
                init.Statements.Insert(suspendIdx, new CodeSnippetStatement(begins[i]));
            }
        }

        /// <summary>Parse a captured init-bracket snippet into (isBegin, target-expression-text) by inspecting the
        /// OUTER invocation's method name and the cast receiver — robust to receivers/args that embed the other
        /// method's spelling. Returns null when the snippet isn't a recognizable BeginInit/EndInit call.</summary>
        private static (bool isBegin, string target)? ClassifyInitBracket(string stmt)
        {
            if (SyntaxFactory.ParseStatement(stmt) is not ExpressionStatementSyntax es
                || es.Expression is not InvocationExpressionSyntax inv
                || inv.Expression is not MemberAccessExpressionSyntax ma)
            {
                return null;
            }
            string method = ma.Name.Identifier.Text;
            if (method is not ("BeginInit" or "EndInit")) return null;
            string target = "";
            if (ma.Expression is ParenthesizedExpressionSyntax pe && pe.Expression is CastExpressionSyntax ce)
            {
                var operand = ce.Expression is ParenthesizedExpressionSyntax inner ? inner.Expression : ce.Expression;
                target = operand.ToString().Trim();
            }
            return (method == "BeginInit", target);
        }

        /// <summary>Index of the <c>ResumeLayout</c> invocation whose receiver renders to <paramref name="target"/>
        /// (e.g. "this.splitContainer1"), or -1.</summary>
        private static int ResumeIndexForTarget(CodeStatementCollection stmts, string target)
        {
            for (int i = 0; i < stmts.Count; i++)
            {
                if (stmts[i] is CodeExpressionStatement { Expression: CodeMethodInvokeExpression mi }
                    && mi.Method.MethodName == "ResumeLayout"
                    && RenderTarget(mi.Method.TargetObject) == target)
                {
                    return i;
                }
            }
            return -1;
        }

        /// <summary>Render the common CodeDom reference expressions the serializer emits back to source text
        /// ("this", "this.field", "this.a.b") so a ResumeLayout receiver can be matched to an EndInit target.</summary>
        private static string RenderTarget(CodeExpression e) => e switch
        {
            CodeThisReferenceExpression => "this",
            CodeFieldReferenceExpression f => RenderTarget(f.TargetObject) + "." + f.FieldName,
            CodePropertyReferenceExpression p => RenderTarget(p.TargetObject) + "." + p.PropertyName,
            CodeVariableReferenceExpression v => v.VariableName,
            _ => "",
        };

        private static bool IsInvoke(CodeStatement s, string method) =>
            s is CodeExpressionStatement { Expression: CodeMethodInvokeExpression mi } && mi.Method.MethodName == method;

        private static int FirstInvokeIndex(CodeStatementCollection stmts, string method)
        {
            for (int i = 0; i < stmts.Count; i++)
            {
                if (IsInvoke(stmts[i], method)) return i;
            }
            return -1;
        }

        private static int LastInvokeIndex(CodeStatementCollection stmts, string method)
        {
            for (int i = stmts.Count - 1; i >= 0; i--)
            {
                if (IsInvoke(stmts[i], method)) return i;
            }
            return -1;
        }

        /// <summary>
        /// Remove over-emitted property assignments inside InitializeComponent,
        /// mutating the method's statement list in place. Two modes:
        ///   • <paramref name="explicitMembers"/> known → keep only properties that were
        ///     explicitly set in the source (exact echo; the complete round-trip fix).
        ///   • otherwise → drop primitive assignments whose value equals the property
        ///     default (general fallback for build/edit without a source).
        /// </summary>
        private static void Normalize(CodeTypeDeclaration ctd, IComponent root, List<IComponent> members,
            HashSet<(IComponent, string)>? explicitMembers, List<string> dropped)
        {
            var byName = new Dictionary<string, IComponent>(StringComparer.Ordinal);
            foreach (var c in members)
            {
                if (c.Site?.Name is { Length: > 0 } n)
                {
                    byName[n] = c;
                }
            }

            var init = ctd.Members.OfType<CodeMemberMethod>().FirstOrDefault(m => m.Name == "InitializeComponent");
            if (init == null)
            {
                return;
            }

            var refCache = new Dictionary<Type, object?>();
            var disposables = new List<IDisposable>();
            try
            {
                var kept = new CodeStatementCollection();
                foreach (CodeStatement stmt in init.Statements)
                {
                    if (ShouldDrop(stmt, root, byName, explicitMembers, refCache, disposables, out string? describe))
                    {
                        dropped.Add(describe!);
                        continue;
                    }
                    kept.Add(stmt);
                }
                init.Statements.Clear();
                init.Statements.AddRange(kept);
            }
            finally
            {
                foreach (var d in disposables)
                {
                    try { d.Dispose(); } catch { /* best effort */ }
                }
            }
        }

        private static bool ShouldDrop(CodeStatement stmt, IComponent root,
            Dictionary<string, IComponent> byName, HashSet<(IComponent, string)>? explicitMembers,
            Dictionary<Type, object?> refCache, List<IDisposable> disposables, out string? describe)
        {
            describe = null;

            // only ever filter property assignments; creation / Controls.Add / layout stay
            if (stmt is not CodeAssignStatement asg) return false;
            if (asg.Left is not CodePropertyReferenceExpression pr) return false;
            if (!TryResolveComponent(pr.TargetObject, root, byName, out IComponent? comp)) return false;

            string owner = ReferenceEquals(comp, root) ? "this" : (comp!.Site?.Name ?? comp.GetType().Name);

            if (explicitMembers != null)
            {
                // exact-echo mode: keep iff the source set this (owner, property)
                if (explicitMembers.Contains((comp!, pr.PropertyName))) return false;
                describe = owner + "." + pr.PropertyName + "  (not in source)";
                return true;
            }

            // default-value fallback mode: only primitive literals equal to the default
            if (asg.Right is not CodePrimitiveExpression prim) return false;
            var pd = TypeDescriptor.GetProperties(comp!)[pr.PropertyName];
            if (pd == null) return false;

            object? value = prim.Value;
            object? def = GetDefault(comp!, pd, refCache, disposables);
            if (!ValuesEqual(value, def)) return false;

            describe = owner + "." + pr.PropertyName + " = " + (value ?? "null") + "  (default)";
            return true;
        }

        /// <summary>Map a CodeDom target (this / this.&lt;field&gt;) back to its component.</summary>
        private static bool TryResolveComponent(CodeExpression target, IComponent root,
            Dictionary<string, IComponent> byName, out IComponent? comp)
        {
            comp = null;
            switch (target)
            {
                case CodeThisReferenceExpression:
                    comp = root;
                    return true;
                case CodeFieldReferenceExpression fr when fr.TargetObject is CodeThisReferenceExpression
                                                          && byName.TryGetValue(fr.FieldName, out var c):
                    comp = c;
                    return true;
                default:
                    return false; // nested / property-of-property → not normalized (kept)
            }
        }

        /// <summary>
        /// Property default: a <see cref="DefaultValueAttribute"/> if declared, else the
        /// value read from a cached fresh reference instance of the component type.
        /// Returns <see cref="Unknown"/> when it cannot be determined (→ assignment kept).
        /// </summary>
        private static object? GetDefault(IComponent comp, PropertyDescriptor pd,
            Dictionary<Type, object?> refCache, List<IDisposable> disposables)
        {
            if (pd.Attributes[typeof(DefaultValueAttribute)] is DefaultValueAttribute dva)
            {
                return dva.Value;
            }

            var t = comp.GetType();
            if (!refCache.TryGetValue(t, out object? inst))
            {
                try { inst = Activator.CreateInstance(t); }
                catch { inst = null; }
                refCache[t] = inst;
                if (inst is IDisposable d) disposables.Add(d);
            }
            if (inst == null) return Unknown;

            try
            {
                var rpd = TypeDescriptor.GetProperties(inst)[pd.Name];
                if (rpd == null) return Unknown;
                return rpd.GetValue(inst);
            }
            catch
            {
                return Unknown;
            }
        }

        private static bool ValuesEqual(object? value, object? def)
        {
            if (ReferenceEquals(def, Unknown)) return false;
            if (value == null) return def == null;
            return value.Equals(def);
        }

        private static string GenerateCode(CodeTypeDeclaration ctd)
        {
            var ns = new CodeNamespace("WinFormsDesigner.Generated");
            ns.Types.Add(ctd);
            var ccu = new CodeCompileUnit();
            ccu.Namespaces.Add(ns);

            var options = new CodeGeneratorOptions
            {
                BracingStyle = "C",
                BlankLinesBetweenMembers = false,
                IndentString = "    ",
            };

            using var provider = new CSharpCodeProvider();
            using var sw = new StringWriter();
            provider.GenerateCodeFromCompileUnit(ccu, sw, options);
            return sw.ToString();
        }
    }
}
