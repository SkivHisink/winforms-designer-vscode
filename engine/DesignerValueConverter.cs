using System;
using System.CodeDom;
using System.CodeDom.Compiler;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.ComponentModel.Design.Serialization;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
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
