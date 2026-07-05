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
    /// over-emission is the #1 source of round-trip merge noise (FINDINGS S2a finding #1,
    /// codex risk C2). We drop, post-serialization, any primitive assignment whose value
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
            IReadOnlyList<string>? eventWirings = null)
        {
            var root = host.RootComponent;
            var manager = new DesignerSerializationManager(surface);
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
