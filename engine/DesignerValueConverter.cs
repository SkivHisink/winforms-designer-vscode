using System;
using System.CodeDom;
using System.CodeDom.Compiler;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design.Serialization;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CSharp;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// Builds an idiomatic VS-dialect C# initializer expression for a complex framework property
    /// value (Point/Size/Color/… — anything with a TypeConverter that round-trips through
    /// InstanceDescriptor) from the invariant string the property grid displays.
    ///
    /// This is the write-side complement to <see cref="DesignerDescribe"/>: the grid shows a value
    /// as <c>TypeConverter.ConvertToInvariantString</c> (e.g. "24, 24" for a Point, "Red" or
    /// "64, 128, 255" for a Color); to edit it we must turn the user's edited string back into the
    /// exact C# the designer would emit. Doing it here — not in the extension — gives three things
    /// the TypeScript side cannot get cheaply:
    ///   • idiomatic output via <see cref="InstanceDescriptor"/>: <c>new System.Drawing.Point(x, y)</c>,
    ///     <c>System.Drawing.Color.Red</c>, <c>System.Drawing.SystemColors.Control</c>,
    ///     <c>System.Drawing.Color.FromArgb(r, g, b)</c> — including the named-vs-system-vs-argb choice
    ///     for Color, which the invariant string alone can't disambiguate;
    ///   • validation for free: <c>ConvertFromInvariantString</c> throws on garbage / out-of-range
    ///     input → we return null and the grid rejects the edit;
    ///   • a single general mechanism (TypeConverter+InstanceDescriptor) behind an explicit
    ///     <see cref="SupportedTypeNames"/> allowlist, so the converter only ever emits expressions
    ///     the renderer's interpreter can read back — no per-type conversion code, but no untested type
    ///     either.
    ///
    /// Returns null when the type/value can't be represented (caller leaves the property read-only).
    /// The emitted expression is consumed by <see cref="DesignerPropertyEditor"/> (targeted text edit)
    /// and must be interpretable by the renderer's Eval (see the static-invocation case there, which
    /// evaluates the Color.FromArgb factory call this can emit).
    /// </summary>
    public static class DesignerValueConverter
    {
        // framework assemblies that host the complex property types a grid edits (Color/Point/Size
        // live in System.Drawing.Primitives; Padding/etc. in System.Windows.Forms). No user ALC here:
        // complex *framework* types only — custom enums/structs are handled TS-side or left read-only.
        private static readonly Assembly[] ProbeAssemblies =
        {
            typeof(Color).Assembly,
            typeof(Point).Assembly,
            typeof(Control).Assembly,
            typeof(Font).Assembly, // System.Drawing.Common — Font (and FontFamily/FontStyle/GraphicsUnit)
            typeof(object).Assembly,
        };

        /// <summary>
        /// Types the grid edits through this path. Deliberately narrow and kept in sync with the
        /// extension's COMPLEX_TYPES (propertyGrid.ts): every entry must BOTH convert here AND be
        /// evaluable by the renderer's interpreter, so a successful conversion can never yield an
        /// expression the re-render fails to read back (e.g. a float-backed SizeF would emit
        /// 'float.NaN', which the interpreter can't resolve). Add a type only after verifying that
        /// full round-trip end-to-end.
        /// </summary>
        private static readonly HashSet<string> SupportedTypeNames = new(StringComparer.Ordinal)
        {
            "System.Drawing.Point",
            "System.Drawing.Size",
            "System.Drawing.Color",
            "System.Drawing.Rectangle",
            "System.Windows.Forms.Padding",
            "System.Drawing.Font",
            // CursorConverter round-trips through InstanceDescriptor: a standard cursor maps to a static
            // property reference (System.Windows.Forms.Cursors.Hand) — structurally identical to the named
            // Color/SystemColors path — which the renderer reads back via AllowedStaticReadTypes (Cursors).
            // Custom/.cur/.resx cursors have no Cursors.* member → ConvertTo(InstanceDescriptor) throws →
            // ToExpression returns null → the property stays read-only (no data loss).
            "System.Windows.Forms.Cursor",
        };

        /// <summary>
        /// Convert an invariant-string value of the named type into a C# initializer expression, or
        /// null if it isn't convertible (unsupported type, no string/InstanceDescriptor support, the
        /// value fails to parse, or it can't be rendered). By contract this NEVER throws — any failure
        /// is a clean "not representable" rejection the caller turns into a rejected edit.
        /// </summary>
        public static string? ToExpression(string typeName, string invariantValue)
        {
            if (!SupportedTypeNames.Contains(typeName)) return null;
            try
            {
                Type? type = ResolveType(typeName);
                if (type == null) return null;

                TypeConverter conv = TypeDescriptor.GetConverter(type);
                if (conv == null) return null;
                if (!conv.CanConvertFrom(typeof(string)) || !conv.CanConvertTo(typeof(InstanceDescriptor))) return null;

                object? value = conv.ConvertFromInvariantString(invariantValue);
                if (value == null) return null;

                // Font-specific: GDI+ silently substitutes an uninstalled family, so the constructed Font.Name
                // would be a DIFFERENT family than the user typed — building the expression from it would quietly
                // rewrite the family on save (loss of the author's intent). Reject the edit (→ grid keeps the
                // shown value) rather than persist a substituted name. Compare case-insensitively because the
                // converter normalizes installed families to their canonical casing.
                if (value is Font f)
                {
                    string requested = invariantValue.Split(',')[0].Trim();
                    if (requested.Length > 0 && !string.Equals(f.Name, requested, StringComparison.OrdinalIgnoreCase))
                    {
                        return null;
                    }
                }

                if (conv.ConvertTo(value, typeof(InstanceDescriptor)) is not InstanceDescriptor id || id.MemberInfo == null) return null;

                CodeExpression? expr = BuildExpression(id);
                if (expr == null) return null;

                return GenerateExpression(expr);
            }
            catch
            {
                // bad/out-of-range input, an InstanceDescriptor shape CodeDom can't render, etc. →
                // graceful null rather than a fault propagated across the JSON-RPC boundary.
                return null;
            }
        }

        /// <summary>
        /// Inverse of <see cref="ToExpression"/>: turn a C# initializer expression (as it appears in a
        /// .Designer.cs) BACK into the invariant grid string, or null if it isn't a representable value of the
        /// named type. This is a deliberately BOUNDED evaluator that mirrors the renderer's Eval allowlists — it
        /// evaluates ONLY the side-effect-free framework shapes the designer emits for Color/Font
        /// (named/system colors, <c>Color.FromArgb(...)</c>, <c>new Font(...)</c>) and never resolves user types
        /// or invokes anything outside those allowlists, so a hand-crafted expression can't run code here. The
        /// resulting value is converted to the invariant string via the type's TypeConverter, so the round-trip
        /// invariant→expression→invariant is stable (the TreeView node editor reads a node's color/font this way
        /// and re-emits it through <see cref="ToExpression"/>).
        ///
        /// Fonts have three refuse-if-lossy guards, because FontConverter's invariant string can't represent every
        /// Font: an uninstalled family (GDI+ would substitute silently), a non-default GdiCharSet, or a vertical
        /// font all return null (→ the caller keeps the value read-only rather than round-trip a rewritten Font).
        /// </summary>
        public static string? FromExpression(string typeName, string expressionText)
        {
            if (!SupportedTypeNames.Contains(typeName)) return null;
            if (string.IsNullOrWhiteSpace(expressionText)) return null;
            try
            {
                Type? type = ResolveType(typeName);
                if (type == null) return null;

                var expr = SyntaxFactory.ParseExpression(expressionText);
                if (expr.ContainsDiagnostics) return null; // not a single clean expression → not representable

                object? value = EvalValue(expr, type);
                if (value == null || !type.IsInstanceOfType(value)) return null;

                if (value is Font f)
                {
                    // FontConverter's invariant string drops GdiCharSet, GdiVerticalFont, and an uninstalled family
                    // (GDI+ substitutes it) — re-emitting from the invariant would silently rewrite the author's
                    // Font. Refuse so the value stays read-only rather than round-trip lossily.
                    if (f.GdiCharSet != 1 /* DEFAULT_CHARSET */ || f.GdiVerticalFont) return null;
                    string? requested = RequestedFontFamily(expr);
                    if (requested != null && requested.Length > 0 && !string.Equals(f.Name, requested, StringComparison.OrdinalIgnoreCase))
                        return null;
                }

                TypeConverter conv = TypeDescriptor.GetConverter(type);
                if (conv == null || !conv.CanConvertTo(typeof(string))) return null;
                return conv.ConvertToInvariantString(value);
            }
            catch
            {
                return null; // bad shape / out-of-range / unresolved member → gracefully not representable
            }
        }

        // ---- bounded framework-value evaluator (Color/Font only; no userAsms, no side-effecting members) ----

        private static readonly HashSet<string> ColorReadTypes = new(StringComparer.Ordinal)
        { "System.Drawing.Color", "System.Drawing.SystemColors" };
        private static readonly HashSet<string> ColorFactories = new(StringComparer.Ordinal)
        { "FromArgb", "FromName", "FromKnownColor" };
        private static readonly HashSet<string> FontConstructionTypes = new(StringComparer.Ordinal)
        { "System.Drawing.Font", "System.Drawing.FontFamily" };

        /// <summary>Evaluate the small, side-effect-free subset of expressions the designer emits for Color/Font.
        /// Returns null (not throws) for anything outside the allowlist so the caller treats it as unrepresentable.</summary>
        private static object? EvalValue(ExpressionSyntax expr, Type? targetType)
        {
            switch (expr)
            {
                case ParenthesizedExpressionSyntax p:
                    return EvalValue(p.Expression, targetType);

                case LiteralExpressionSyntax lit:
                    return lit.Token.Value; // int/double/float/string/bool/char/null (typed by suffix)

                case PrefixUnaryExpressionSyntax u when u.IsKind(SyntaxKind.UnaryMinusExpression):
                    {
                        var inner = EvalValue(u.Operand, targetType);
                        return inner switch { int i => -i, double d => -d, float fl => -fl, long l => -l, _ => inner };
                    }

                case CastExpressionSyntax cast:
                    {
                        Type? ct = ResolveCastType(cast.Type);
                        object? v = EvalValue(cast.Expression, ct);
                        if (ct == null || v == null) return v;
                        if (ct.IsEnum && v is IConvertible) return Enum.ToObject(ct, v);
                        if (v is IConvertible) { try { return Convert.ChangeType(v, ct); } catch { return v; } }
                        return v;
                    }

                case MemberAccessExpressionSyntax ma:
                    {
                        string member = ma.Name.Identifier.Text;
                        Type? t = ResolveType(ma.Expression.ToString());
                        if (t != null)
                        {
                            if (t.IsEnum) return Enum.Parse(t, member);                 // FontStyle.Bold / GraphicsUnit.Point / KnownColor.Red
                            if (t.FullName != null && ColorReadTypes.Contains(t.FullName)) // Color.Red / SystemColors.Control
                            {
                                var pi = t.GetProperty(member, BindingFlags.Public | BindingFlags.Static);
                                if (pi != null) return pi.GetValue(null);
                                var fi = t.GetField(member, BindingFlags.Public | BindingFlags.Static);
                                if (fi != null) return fi.GetValue(null);
                            }
                        }
                        if (targetType != null && targetType.IsEnum) return Enum.Parse(targetType, member);
                        return null;
                    }

                case BinaryExpressionSyntax be when be.IsKind(SyntaxKind.BitwiseOrExpression):
                    {
                        object? l = EvalValue(be.Left, targetType);
                        object? r = EvalValue(be.Right, targetType);
                        Type? et = targetType is { IsEnum: true } ? targetType
                                 : l?.GetType() is { IsEnum: true } lt ? lt
                                 : r?.GetType() is { IsEnum: true } rt ? rt : null;
                        if (et == null || l == null || r == null) return null;
                        return Enum.ToObject(et, Convert.ToInt64(l) | Convert.ToInt64(r));
                    }

                case InvocationExpressionSyntax inv when inv.Expression is MemberAccessExpressionSyntax mai:
                    {
                        Type? t = ResolveType(mai.Expression.ToString());
                        string methodName = mai.Name.Identifier.Text;
                        if (t?.FullName != "System.Drawing.Color" || !ColorFactories.Contains(methodName)) return null;
                        var args = inv.ArgumentList.Arguments.Select(a => EvalValue(a.Expression, null)).ToArray();
                        if (args.Any(a => a == null)) return null;
                        var mi = FindStaticMethod(t, methodName, args);
                        if (mi == null) return null;
                        var ps = mi.GetParameters();
                        var call = new object?[args.Length];
                        for (int i = 0; i < args.Length; i++) call[i] = Coerce(args[i], ps[i].ParameterType);
                        return mi.Invoke(null, call);
                    }

                case ObjectCreationExpressionSyntax oc:
                    {
                        Type? t = ResolveType(oc.Type.ToString());
                        if (t?.FullName == null || !FontConstructionTypes.Contains(t.FullName)) return null;
                        var args = (oc.ArgumentList?.Arguments.Select(a => EvalValue(a.Expression, null)).ToArray()) ?? Array.Empty<object?>();
                        if (args.Any(a => a == null)) return null;
                        var ci = FindConstructor(t, args);
                        if (ci == null) return null;
                        var ps = ci.GetParameters();
                        var call = new object?[args.Length];
                        for (int i = 0; i < args.Length; i++) call[i] = Coerce(args[i], ps[i].ParameterType);
                        return ci.Invoke(call);
                    }

                default:
                    return null;
            }
        }

        private static Type? ResolveCastType(TypeSyntax type)
        {
            if (type is PredefinedTypeSyntax p)
            {
                return p.Keyword.Kind() switch
                {
                    SyntaxKind.ByteKeyword => typeof(byte),
                    SyntaxKind.SByteKeyword => typeof(sbyte),
                    SyntaxKind.ShortKeyword => typeof(short),
                    SyntaxKind.UShortKeyword => typeof(ushort),
                    SyntaxKind.IntKeyword => typeof(int),
                    SyntaxKind.UIntKeyword => typeof(uint),
                    SyntaxKind.LongKeyword => typeof(long),
                    SyntaxKind.ULongKeyword => typeof(ulong),
                    SyntaxKind.FloatKeyword => typeof(float),
                    SyntaxKind.DoubleKeyword => typeof(double),
                    _ => null,
                };
            }
            return ResolveType(type.ToString());
        }

        /// <summary>The requested family name for the Font substitution guard: the ctor's first string-literal
        /// argument, or the string inside a <c>new FontFamily("X")</c> first argument. Null when it can't be
        /// determined syntactically (then the guard is skipped — the ctor still had to evaluate to a Font).</summary>
        private static string? RequestedFontFamily(ExpressionSyntax expr)
        {
            if (expr is not ObjectCreationExpressionSyntax oc || oc.ArgumentList == null || oc.ArgumentList.Arguments.Count == 0)
                return null;
            var a0 = oc.ArgumentList.Arguments[0].Expression;
            if (a0 is LiteralExpressionSyntax lit && lit.IsKind(SyntaxKind.StringLiteralExpression))
                return lit.Token.ValueText;
            if (a0 is ObjectCreationExpressionSyntax nested && nested.ArgumentList is { Arguments.Count: > 0 }
                && nested.ArgumentList.Arguments[0].Expression is LiteralExpressionSyntax nlit && nlit.IsKind(SyntaxKind.StringLiteralExpression))
                return nlit.Token.ValueText;
            return null;
        }

        private static bool IsNumeric(Type t) =>
            t == typeof(byte) || t == typeof(sbyte) || t == typeof(short) || t == typeof(ushort)
            || t == typeof(int) || t == typeof(uint) || t == typeof(long) || t == typeof(ulong)
            || t == typeof(float) || t == typeof(double) || t == typeof(decimal);

        /// <summary>Strict arg/parameter compatibility used to pick a ctor/overload: an exact instance, a numeric
        /// widening/narrowing between primitives, or an enum from an integer. Deliberately does NOT allow arbitrary
        /// Convert.ChangeType (which would let a string match a FontFamily parameter and pick the wrong overload).</summary>
        private static bool ArgsCompatible(ParameterInfo[] ps, object?[] args)
        {
            if (ps.Length != args.Length) return false;
            for (int i = 0; i < ps.Length; i++)
            {
                Type pt = ps[i].ParameterType;
                object? a = args[i];
                if (a == null) { if (pt.IsValueType && Nullable.GetUnderlyingType(pt) == null) return false; continue; }
                if (pt.IsInstanceOfType(a)) continue;
                if (IsNumeric(pt) && IsNumeric(a.GetType())) continue;
                // an EXACT-type enum arg already matched above (IsInstanceOfType); here allow ONLY a non-enum integral
                // to initialize an enum parameter. Never let one enum type satisfy a different enum parameter — e.g. a
                // GraphicsUnit arg must NOT match a FontStyle parameter, or FindConstructor would pick the wrong 3-arg
                // Font overload and silently reinterpret the numeric value (Pixel→Italic), corrupting the font.
                if (pt.IsEnum && !a.GetType().IsEnum && a is IConvertible) continue;
                return false;
            }
            return true;
        }

        private static ConstructorInfo? FindConstructor(Type t, object?[] args) =>
            t.GetConstructors(BindingFlags.Public | BindingFlags.Instance).FirstOrDefault(ci => ArgsCompatible(ci.GetParameters(), args));

        private static MethodInfo? FindStaticMethod(Type t, string name, object?[] args) =>
            t.GetMethods(BindingFlags.Public | BindingFlags.Static)
                .FirstOrDefault(m => m.Name == name && ArgsCompatible(m.GetParameters(), args));

        private static object? Coerce(object? v, Type target)
        {
            if (v == null) return null;
            if (target.IsInstanceOfType(v)) return v;
            if (target.IsEnum && v is IConvertible) return Enum.ToObject(target, v);
            try { return Convert.ChangeType(v, Nullable.GetUnderlyingType(target) ?? target); }
            catch { return v; }
        }

        private static Type? ResolveType(string typeName)
        {
            Type? t = Type.GetType(typeName);
            if (t != null) return t;
            foreach (var asm in ProbeAssemblies)
            {
                t = asm.GetType(typeName);
                if (t != null) return t;
            }
            return null;
        }

        /// <summary>Map an InstanceDescriptor (member + args) to the CodeDom expression that recreates it.</summary>
        private static CodeExpression? BuildExpression(InstanceDescriptor id)
        {
            var args = new List<CodeExpression>();
            foreach (var a in (IEnumerable)id.Arguments)
            {
                var ae = BuildArg(a);
                if (ae == null) return null; // an arg we can't represent → reject the whole expression
                args.Add(ae);
            }

            switch (id.MemberInfo)
            {
                case ConstructorInfo ci when ci.DeclaringType != null:
                    return new CodeObjectCreateExpression(new CodeTypeReference(ci.DeclaringType), args.ToArray());
                case MethodInfo mi when mi.DeclaringType != null:
                    return new CodeMethodInvokeExpression(
                        new CodeTypeReferenceExpression(mi.DeclaringType), mi.Name, args.ToArray());
                // NB: fully-qualified — this namespace also declares a DTO named PropertyInfo (DesignerDescribe).
                case System.Reflection.PropertyInfo pi when pi.DeclaringType != null:
                    return new CodePropertyReferenceExpression(new CodeTypeReferenceExpression(pi.DeclaringType), pi.Name);
                case FieldInfo fi when fi.DeclaringType != null:
                    return new CodeFieldReferenceExpression(new CodeTypeReferenceExpression(fi.DeclaringType), fi.Name);
                default:
                    return null;
            }
        }

        private static CodeExpression? BuildArg(object? a)
        {
            if (a == null) return new CodePrimitiveExpression(null);

            Type t = a.GetType();
            if (t.IsEnum)
            {
                string name = a.ToString() ?? "";
                if (name.Length == 0) return null;
                // a combined-flags value stringifies as "A, B" (e.g. FontStyle.Bold|Italic) — fold it into a
                // bitwise-or chain of member references (Type.A | Type.B), which the renderer's interpreter
                // reads back (its broadened bitwise-or Eval infers the enum type from the operands). A single
                // member is just the first link. Reject if any token isn't a plain member name (e.g. a numeric
                // value with no named flags) so we never emit Type.5 which isn't valid C#.
                var members = name.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
                if (members.Length == 0) return null;
                var typeRef = new CodeTypeReferenceExpression(t);
                CodeExpression? acc = null;
                foreach (var m in members)
                {
                    if (!IsIdentifier(m)) return null;
                    CodeExpression member = new CodeFieldReferenceExpression(typeRef, m);
                    acc = acc == null
                        ? member
                        : new CodeBinaryOperatorExpression(acc, CodeBinaryOperatorType.BitwiseOr, member);
                }
                return acc;
            }
            if (t.IsPrimitive || a is string || a is decimal)
            {
                return new CodePrimitiveExpression(a);
            }

            // a nested complex arg (rare; e.g. a Color inside another value) → recurse via its converter
            var conv = TypeDescriptor.GetConverter(t);
            if (conv != null && conv.CanConvertTo(typeof(InstanceDescriptor)))
            {
                try
                {
                    if (conv.ConvertTo(a, typeof(InstanceDescriptor)) is InstanceDescriptor nid && nid.MemberInfo != null)
                    {
                        return BuildExpression(nid);
                    }
                }
                catch { /* fall through to reject */ }
            }
            return null;
        }

        /// <summary>True if s is a plain C# identifier (letter/underscore start, then letters/digits/underscore).</summary>
        private static bool IsIdentifier(string s)
        {
            if (s.Length == 0) return false;
            if (!(char.IsLetter(s[0]) || s[0] == '_')) return false;
            for (int i = 1; i < s.Length; i++)
            {
                if (!(char.IsLetterOrDigit(s[i]) || s[i] == '_')) return false;
            }
            return true;
        }

        private static string GenerateExpression(CodeExpression expr)
        {
            using var provider = new CSharpCodeProvider();
            using var sw = new StringWriter();
            provider.GenerateCodeFromExpression(expr, sw, new CodeGeneratorOptions());
            return sw.ToString().Trim();
        }
    }
}
