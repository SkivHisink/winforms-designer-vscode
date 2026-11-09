using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Numerics;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>A C# compile-time constant: its value, boxed as exactly its type (an enum constant boxed as its enum),
    /// and that type. Both are null for the null literal.</summary>
    internal readonly record struct DesignerConstant(object? Value, Type? Type);

    /// <summary>What <see cref="DesignerConstantFolder.Fold"/> made of an expression.</summary>
    internal enum ConstantFold
    {
        /// <summary>Not a constant expression (a construction, a call, a property, a local), or a name the caller does not
        /// bind as a constant: the caller evaluates it its own way.</summary>
        NotConstant,
        /// <summary>Folded to the value and type the compiler gives it.</summary>
        Folded,
        /// <summary>A constant expression the compiler rejects (an overflow in a checked context, a division by zero, an
        /// operator that does not apply or is ambiguous), or one whose value C# leaves unspecified. Never guessed.</summary>
        Refused,
    }

    /// <summary>The names inside a constant expression, bound by the caller: the interpreter and the build confirmation
    /// each bind names their own way, and both fold what they bind with <see cref="DesignerConstantFolder"/>.</summary>
    internal interface IDesignerConstantNames
    {
        /// <summary>The constant a name used as a value denotes (an enum member, a constant field), or
        /// <see cref="ConstantFold.NotConstant"/> when the caller does not take it as one. <paramref name="hint"/> is the
        /// type the value is converted to where the context tells it.</summary>
        ConstantFold Name(ExpressionSyntax name, Type? hint, out DesignerConstant constant, out string? refusal);

        /// <summary>The type a cast names when it is not a keyword: null with <paramref name="refusal"/> when the name
        /// cannot be bound, null without one when the caller leaves the cast to its own evaluation.</summary>
        Type? CastType(TypeSyntax type, out string? refusal);
    }

    /// <summary>
    /// Folds a C# constant expression to the value and type the compiler stores. It is the one folder for both the
    /// modern interpreter, which applies the value, and the build confirmation (<see cref="DesignerTypeScope"/>), which
    /// compares it with the project's compiled InitializeComponent. A value can therefore never be confirmed in one form
    /// and applied in another.
    ///
    /// It follows the C# rules:
    /// <list type="bullet">
    /// <item>literals are typed as the lexer types them;</item>
    /// <item>unary and binary operators are chosen by overload resolution over the predefined operators, including the
    /// implicit conversions an int or long constant has to a narrower type and a zero constant has to an enum;</item>
    /// <item>the enum operators and string concatenation and equality are covered;</item>
    /// <item>explicit conversions and arithmetic run in the checked context constants are folded in, unless
    /// <c>unchecked(…)</c> says otherwise.</item>
    /// </list>
    /// What the compiler rejects is refused, and so is what C# leaves unspecified (a floating value outside an integral
    /// type's range in an unchecked context). Nothing is run: names are read only through the caller.
    /// </summary>
    internal static class DesignerConstantFolder
    {
        /// <summary>Deeper nesting than any designer writes; a long CodeDom string split is folded without recursion.</summary>
        private const int MaxDepth = 256;

        private static readonly Type[] Arithmetic =
            { typeof(int), typeof(uint), typeof(long), typeof(ulong), typeof(float), typeof(double), typeof(decimal) };
        private static readonly Type[] Integers = { typeof(int), typeof(uint), typeof(long), typeof(ulong) };
        private static readonly Type[] Negatable = { typeof(int), typeof(long), typeof(float), typeof(double), typeof(decimal) };

        /// <summary>Whether <paramref name="expression"/> is an operator, a cast or a literal: the shapes a constant
        /// expression is built of. A name on its own is the caller's to evaluate.</summary>
        public static bool MayFold(ExpressionSyntax expression) => expression is LiteralExpressionSyntax
            or ParenthesizedExpressionSyntax or CheckedExpressionSyntax or PrefixUnaryExpressionSyntax
            or BinaryExpressionSyntax or CastExpressionSyntax;

        /// <summary>Fold <paramref name="expression"/>. <paramref name="hint"/> is passed to the names it contains.</summary>
        public static ConstantFold Fold(ExpressionSyntax expression, IDesignerConstantNames names, Type? hint,
            out DesignerConstant constant, out string? refusal)
        {
            // Syntax the parser had to recover (`(1 + 1`) has only the value the recovery gives it.
            if (expression.ContainsDiagnostics && expression.GetDiagnostics().Any(d => d.Severity == DiagnosticSeverity.Error))
            {
                constant = default;
                refusal = "the expression '" + Text(expression) + "' does not compile";
                return ConstantFold.Refused;
            }
            var outcome = new Folder(names).Fold(expression, hint, true, 0);
            constant = outcome.Constant;
            refusal = outcome.Refusal;
            return outcome.Kind;
        }

        /// <summary>Whether a value of type <paramref name="from"/> converts implicitly to <paramref name="to"/> by its type
        /// alone: identity or an implicit numeric conversion (no constant narrowing, which needs the constant).</summary>
        public static bool ConvertsImplicitly(Type from, Type to) => from == to || ImplicitNumeric(from, to);

        /// <summary>The types a constant can have: the numeric types, char, bool, string and the enums.</summary>
        public static bool IsConstantType(Type type) => type.IsEnum || type == typeof(string) || type == typeof(bool) || IsNumeric(type);

        /// <summary>
        /// <paramref name="constant"/> as a value of <paramref name="to"/>, the type of the property, parameter or element
        /// it is given to: only by C#'s implicit conversion of a constant, which the assignment compiles with. An explicit
        /// conversion needs a cast in the source, even where it would keep the value (<c>MaxLength = 1L + 1L</c> does not
        /// compile). The one addition is the same enum loaded from another assembly, which is the same type to C#.
        /// </summary>
        public static bool TryAssign(DesignerConstant constant, Type to, out DesignerConstant converted)
        {
            converted = default;
            if (ConvertsImplicitly(constant, to)) return TryConvert(constant, to, true, out converted, out _);
            return constant.Type != null && SameEnum(constant.Type, to) && TryConvert(constant, to, true, out converted, out _);
        }

        /// <summary>C#'s explicit conversion of a value of a numeric, char or enum type to another, checked: a value out of
        /// the target's range, or a floating value that is not a number, is refused rather than wrapped.</summary>
        public static bool TryConvertExplicit(DesignerConstant value, Type to, out DesignerConstant converted, out string? refusal) =>
            TryConvert(value, to, true, out converted, out refusal);

        /// <summary>Whether two enum types are the same enum loaded twice: the same full name in an assembly of the same
        /// name. A project's own enum named like a framework one is another type.</summary>
        public static bool SameEnum(Type a, Type b) =>
            a.IsEnum && b.IsEnum && string.Equals(a.FullName, b.FullName, StringComparison.Ordinal)
            && string.Equals(a.Assembly.GetName().Name, b.Assembly.GetName().Name, StringComparison.OrdinalIgnoreCase);

        // ------------------------------------------------------------------ the walk ---------------------------------

        private readonly record struct Outcome(ConstantFold Kind, DesignerConstant Constant, string? Refusal)
        {
            public static readonly Outcome NotConstant = new(ConstantFold.NotConstant, default, null);
            public static Outcome Of(object? value, Type? type) => new(ConstantFold.Folded, new DesignerConstant(Canonical(value), type), null);
            public static Outcome Of(DesignerConstant constant) => Of(constant.Value, constant.Type);
            public static Outcome Refuse(string why) => new(ConstantFold.Refused, default, why);
        }

        /// <summary>The compiler stores every NaN it folds as <see cref="double.NaN"/> or <see cref="float.NaN"/>, whatever
        /// bits the operation produced.</summary>
        private static object? Canonical(object? value) => value switch
        {
            double d when double.IsNaN(d) => double.NaN,
            float f when float.IsNaN(f) => float.NaN,
            _ => value,
        };

        private enum Op { Numeric, Bool, EnumBits, EnumCompare, EnumPlus, EnumMinus, EnumDifference }

        /// <summary>A predefined operator: its parameter types, its result type, and how it computes.</summary>
        private readonly record struct Candidate(Type[] Parameters, Type Result, Op Kind);

        private sealed class Folder
        {
            private readonly IDesignerConstantNames _names;

            public Folder(IDesignerConstantNames names) => _names = names;

            public Outcome Fold(ExpressionSyntax e, Type? hint, bool chk, int depth)
            {
                if (depth > MaxDepth) return Outcome.Refuse("constant expression nested too deeply: '" + Text(e) + "'");
                switch (e)
                {
                    case LiteralExpressionSyntax literal:
                        return Literal(literal);
                    case ParenthesizedExpressionSyntax p:
                        return Fold(p.Expression, hint, chk, depth + 1);
                    case CheckedExpressionSyntax c:
                        return Fold(c.Expression, hint, c.IsKind(SyntaxKind.CheckedExpression), depth + 1);
                    case PrefixUnaryExpressionSyntax u:
                        return Unary(u, hint, chk, depth);
                    case BinaryExpressionSyntax b:
                        return Binary(b, hint, chk, depth);
                    case CastExpressionSyntax cast:
                        return Cast(cast, chk, depth);
                    case MemberAccessExpressionSyntax or IdentifierNameSyntax:
                        return _names.Name(e, hint, out var constant, out string? refusal) switch
                        {
                            ConstantFold.Folded => Outcome.Of(constant),
                            ConstantFold.Refused => Outcome.Refuse(refusal ?? "cannot bind '" + Text(e) + "'"),
                            _ => Outcome.NotConstant,
                        };
                    default:
                        return Outcome.NotConstant;
                }
            }

            private static Outcome Literal(LiteralExpressionSyntax literal)
            {
                switch (literal.Kind())
                {
                    case SyntaxKind.NullLiteralExpression:
                        return Outcome.Of(null, null);
                    case SyntaxKind.TrueLiteralExpression:
                    case SyntaxKind.FalseLiteralExpression:
                    case SyntaxKind.StringLiteralExpression:
                    case SyntaxKind.CharacterLiteralExpression:
                    case SyntaxKind.NumericLiteralExpression:
                        // A literal the lexer reports (too large, out of range) has no value the compiler accepts.
                        if (literal.Token.ContainsDiagnostics) return Outcome.Refuse("the literal " + Text(literal) + " does not compile");
                        return literal.Token.Value is { } value && IsConstantType(value.GetType())
                            ? Outcome.Of(value, value.GetType())
                            : Outcome.NotConstant;
                    default:
                        // `default`, a UTF-8 string, `__arglist`: not a constant of a type known here.
                        return Outcome.NotConstant;
                }
            }

            private Outcome Cast(CastExpressionSyntax cast, bool chk, int depth)
            {
                Type? to;
                if (cast.Type is PredefinedTypeSyntax keyword) to = KeywordType(keyword.Keyword.Kind());
                else
                {
                    to = _names.CastType(cast.Type, out string? refusal);
                    if (refusal != null) return Outcome.Refuse(refusal);
                }
                // A cast to object, an interface, a nullable or any other type is not a constant: the caller converts.
                if (to == null || !IsConstantType(to)) return Outcome.NotConstant;
                var operand = Fold(cast.Expression, to, chk, depth + 1);
                if (operand.Kind != ConstantFold.Folded) return operand;
                return TryConvert(operand.Constant, to, chk, out var converted, out string? why)
                    ? Outcome.Of(converted)
                    : Outcome.Refuse(why + ": '" + Text(cast) + "'");
            }

            private Outcome Unary(PrefixUnaryExpressionSyntax u, Type? hint, bool chk, int depth)
            {
                var kind = u.Kind();
                if (kind is not (SyntaxKind.UnaryMinusExpression or SyntaxKind.UnaryPlusExpression
                    or SyntaxKind.BitwiseNotExpression or SyntaxKind.LogicalNotExpression))
                    return Outcome.NotConstant;
                // The literals 2147483648 and 9223372036854775808 right after a minus are the int and long minimum.
                // Anywhere else they are a uint and a ulong. The compiler decides by the literal's value, decimal or
                // hexadecimal (`-0x80000000` is the int minimum too), unless a U suffix makes the literal unsigned.
                if (kind == SyntaxKind.UnaryMinusExpression && u.Operand is LiteralExpressionSyntax literal
                    && literal.IsKind(SyntaxKind.NumericLiteralExpression) && !literal.Token.ContainsDiagnostics
                    && !HasUnsignedSuffix(literal.Token.Text))
                {
                    if (literal.Token.Value is uint ui && ui == 2147483648u) return Outcome.Of(int.MinValue, typeof(int));
                    if (literal.Token.Value is ulong ul && ul == 9223372036854775808ul) return Outcome.Of(long.MinValue, typeof(long));
                }
                var operand = Fold(u.Operand, hint, chk, depth + 1);
                if (operand.Kind != ConstantFold.Folded) return operand;
                var a = operand.Constant;
                if (a.Type == null || a.Type == typeof(string)) return Outcome.NotConstant;

                var candidates = new List<Candidate>();
                switch (kind)
                {
                    case SyntaxKind.UnaryPlusExpression:
                        foreach (var t in Arithmetic) candidates.Add(new Candidate(new[] { t }, t, Op.Numeric));
                        break;
                    case SyntaxKind.UnaryMinusExpression:
                        foreach (var t in Negatable) candidates.Add(new Candidate(new[] { t }, t, Op.Numeric));
                        break;
                    case SyntaxKind.BitwiseNotExpression:
                        foreach (var t in Integers) candidates.Add(new Candidate(new[] { t }, t, Op.Numeric));
                        if (a.Type.IsEnum) candidates.Add(new Candidate(new[] { a.Type }, a.Type, Op.EnumBits));
                        break;
                    default:
                        candidates.Add(new Candidate(new[] { typeof(bool) }, typeof(bool), Op.Bool));
                        break;
                }
                int chosen = Resolve(candidates, new[] { a });
                if (chosen < 0)
                    return Outcome.Refuse("operator '" + u.OperatorToken.Text + "' " + (chosen == -1 ? "cannot be applied" : "is ambiguous")
                        + " on an operand of type " + Describe(a.Type) + ": '" + Text(u) + "'");
                var op = candidates[chosen];
                if (!TryConvert(a, op.Parameters[0], chk, out var x, out string? why)) return Outcome.Refuse(why!);

                switch (op.Kind)
                {
                    case Op.Bool:
                        return Outcome.Of(!(bool)x.Value!, typeof(bool));
                    case Op.EnumBits:
                        {
                            // `~E` complements the underlying value in its own width.
                            var underlying = Enum.GetUnderlyingType(op.Result);
                            var n = Wrap(underlying, -Integer(x.Value!) - 1);
                            return Outcome.Of(Enum.ToObject(op.Result, Box(underlying, n)), op.Result);
                        }
                }
                var type = op.Result;
                switch (x.Value)
                {
                    case float f: return Outcome.Of(kind == SyntaxKind.UnaryMinusExpression ? -f : f, type);
                    case double d: return Outcome.Of(kind == SyntaxKind.UnaryMinusExpression ? -d : d, type);
                    case decimal m: return Outcome.Of(kind == SyntaxKind.UnaryMinusExpression ? -m : m, type);
                }
                var value = Integer(x.Value!);
                var result = kind switch
                {
                    SyntaxKind.UnaryMinusExpression => -value,
                    SyntaxKind.BitwiseNotExpression => -value - 1,
                    _ => value,
                };
                if (!InRange(type, result))
                {
                    // `~` never overflows; `-int.MinValue` does.
                    if (kind == SyntaxKind.UnaryMinusExpression && chk)
                        return Outcome.Refuse("the constant expression '" + Text(u) + "' overflows in a checked context");
                    result = Wrap(type, result);
                }
                return Outcome.Of(Box(type, result), type);
            }

            private Outcome Binary(BinaryExpressionSyntax b, Type? hint, bool chk, int depth)
            {
                var kind = b.Kind();
                if (!IsFoldedOperator(kind)) return Outcome.NotConstant;
                // CodeDom splits a string longer than 80 characters into a chain of literals: folded without recursion.
                if (kind == SyntaxKind.AddExpression && DesignerIrBuilder.TryConcatStringLiterals(b, out string joined))
                    return Outcome.Of(joined, typeof(string));
                var left = Fold(b.Left, hint, chk, depth + 1);
                if (left.Kind != ConstantFold.Folded) return left;
                var right = Fold(b.Right, hint, chk, depth + 1);
                if (right.Kind != ConstantFold.Folded) return right;
                DesignerConstant x = left.Constant, y = right.Constant;

                // Strings and null: concatenation and equality between strings are constants; anything else with a string
                // (`"a" + 1`) is a valid expression that is not a constant, and null with a number is a nullable operation.
                if (x.Type == null || y.Type == null || x.Type == typeof(string) || y.Type == typeof(string))
                {
                    bool strings = (x.Type == null || x.Type == typeof(string)) && (y.Type == null || y.Type == typeof(string));
                    if (!strings || kind is not (SyntaxKind.AddExpression or SyntaxKind.EqualsExpression or SyntaxKind.NotEqualsExpression))
                        return Outcome.NotConstant;
                    if (x.Type == null && y.Type == null)
                        return kind == SyntaxKind.AddExpression
                            ? Outcome.Refuse("operator '+' is ambiguous on operands of type <null> and <null>: '" + Text(b) + "'")
                            : Outcome.NotConstant;
                    string? s = (string?)x.Value, t = (string?)y.Value;
                    return kind switch
                    {
                        SyntaxKind.AddExpression => Outcome.Of(s + t, typeof(string)),
                        SyntaxKind.EqualsExpression => Outcome.Of(string.Equals(s, t, StringComparison.Ordinal), typeof(bool)),
                        _ => Outcome.Of(!string.Equals(s, t, StringComparison.Ordinal), typeof(bool)),
                    };
                }

                var candidates = Candidates(kind);
                foreach (var type in new[] { x.Type, y.Type }.Distinct())
                    if (type.IsEnum) AddEnumCandidates(kind, type, candidates);
                int chosen = Resolve(candidates, new[] { x, y });
                // `U - E`, as in `1 - AnchorStyles.Top`, is not in the specification. The compiler keeps it from its
                // predecessor only where no other operator applies: `0 - E` is still `E - E`.
                if (chosen == -1 && kind == SyntaxKind.SubtractExpression && y.Type.IsEnum)
                {
                    candidates = new List<Candidate> { new(new[] { Enum.GetUnderlyingType(y.Type), y.Type }, y.Type, Op.EnumMinus) };
                    chosen = Resolve(candidates, new[] { x, y });
                }
                if (chosen < 0)
                    return Outcome.Refuse("operator '" + b.OperatorToken.Text + "' " + (chosen == -1 ? "cannot be applied" : "is ambiguous")
                        + " on operands of type " + Describe(x.Type) + " and " + Describe(y.Type) + ": '" + Text(b) + "'");
                var op = candidates[chosen];
                if (!TryConvert(x, op.Parameters[0], chk, out var cx, out string? why)
                    || !TryConvert(y, op.Parameters[1], chk, out var cy, out why))
                    return Outcome.Refuse(why!);
                return op.Kind switch
                {
                    Op.Numeric => NumericBinary(kind, op.Parameters[0], cx.Value!, cy.Value!, chk, b),
                    Op.Bool => BoolBinary(kind, (bool)cx.Value!, (bool)cy.Value!),
                    _ => EnumBinary(kind, op, cx.Value!, cy.Value!, chk, b),
                };
            }

            private static Outcome NumericBinary(SyntaxKind kind, Type type, object x, object y, bool chk, BinaryExpressionSyntax b)
            {
                switch (x)
                {
                    case float f:
                        {
                            float g = (float)y;
                            return Compare(kind, f.CompareTo(g), f == g, float.IsNaN(f) || float.IsNaN(g)) is { } fc ? Outcome.Of(fc, typeof(bool))
                                : Outcome.Of(kind switch
                                {
                                    SyntaxKind.AddExpression => f + g,
                                    SyntaxKind.SubtractExpression => f - g,
                                    SyntaxKind.MultiplyExpression => f * g,
                                    SyntaxKind.DivideExpression => f / g,
                                    _ => f % g,
                                }, typeof(float));
                        }
                    case double d:
                        {
                            double e = (double)y;
                            return Compare(kind, d.CompareTo(e), d == e, double.IsNaN(d) || double.IsNaN(e)) is { } dc ? Outcome.Of(dc, typeof(bool))
                                : Outcome.Of(kind switch
                                {
                                    SyntaxKind.AddExpression => d + e,
                                    SyntaxKind.SubtractExpression => d - e,
                                    SyntaxKind.MultiplyExpression => d * e,
                                    SyntaxKind.DivideExpression => d / e,
                                    _ => d % e,
                                }, typeof(double));
                        }
                    case decimal m:
                        {
                            decimal n = (decimal)y;
                            if (Compare(kind, m.CompareTo(n), m == n, false) is { } mc) return Outcome.Of(mc, typeof(bool));
                            try
                            {
                                return Outcome.Of(kind switch
                                {
                                    SyntaxKind.AddExpression => m + n,
                                    SyntaxKind.SubtractExpression => m - n,
                                    SyntaxKind.MultiplyExpression => m * n,
                                    SyntaxKind.DivideExpression => m / n,
                                    _ => m % n,
                                }, typeof(decimal));
                            }
                            catch (DivideByZeroException) { return Outcome.Refuse("'" + Text(b) + "' divides by the constant zero"); }
                            catch (OverflowException) { return Outcome.Refuse("the constant expression '" + Text(b) + "' overflows"); }
                        }
                }

                if (kind is SyntaxKind.LeftShiftExpression or SyntaxKind.RightShiftExpression or SyntaxKind.UnsignedRightShiftExpression)
                {
                    int count = (int)y;
                    object shifted = x switch
                    {
                        int i => kind == SyntaxKind.LeftShiftExpression ? i << count : kind == SyntaxKind.RightShiftExpression ? i >> count : i >>> count,
                        uint u => kind == SyntaxKind.LeftShiftExpression ? u << count : u >> count,
                        long l => kind == SyntaxKind.LeftShiftExpression ? l << count : kind == SyntaxKind.RightShiftExpression ? l >> count : l >>> count,
                        _ => kind == SyntaxKind.LeftShiftExpression ? (ulong)x << count : (ulong)x >> count,
                    };
                    return Outcome.Of(shifted, type);
                }

                BigInteger p = Integer(x), q = Integer(y);
                if (Compare(kind, p.CompareTo(q), p == q, false) is { } ic) return Outcome.Of(ic, typeof(bool));
                // The minimum divided by -1 overflows like any result out of range (unchecked, it is the minimum); the
                // remainder by -1 is 0, as the compiler folds it.
                if (kind is SyntaxKind.DivideExpression or SyntaxKind.ModuloExpression && q.IsZero)
                    return Outcome.Refuse("'" + Text(b) + "' divides by the constant zero");
                BigInteger r = kind switch
                {
                    SyntaxKind.AddExpression => p + q,
                    SyntaxKind.SubtractExpression => p - q,
                    SyntaxKind.MultiplyExpression => p * q,
                    SyntaxKind.DivideExpression => BigInteger.Divide(p, q),
                    SyntaxKind.ModuloExpression => BigInteger.Remainder(p, q),
                    SyntaxKind.BitwiseAndExpression => p & q,
                    SyntaxKind.BitwiseOrExpression => p | q,
                    _ => p ^ q,
                };
                if (!InRange(type, r))
                {
                    if (chk) return Outcome.Refuse("the constant expression '" + Text(b) + "' overflows in a checked context");
                    r = Wrap(type, r);
                }
                return Outcome.Of(Box(type, r), type);
            }

            private static Outcome BoolBinary(SyntaxKind kind, bool x, bool y) => Outcome.Of(kind switch
            {
                SyntaxKind.BitwiseAndExpression or SyntaxKind.LogicalAndExpression => x & y,
                SyntaxKind.BitwiseOrExpression or SyntaxKind.LogicalOrExpression => x | y,
                SyntaxKind.ExclusiveOrExpression => x ^ y,
                SyntaxKind.EqualsExpression => x == y,
                _ => x != y,
            }, typeof(bool));

            /// <summary>The enum operators, computed on the underlying values: <c>E | E</c>, <c>E &amp; E</c> and
            /// <c>E ^ E</c> are E; <c>E + U</c>, <c>U + E</c> and <c>E - U</c> are E; <c>E - E</c> is U; comparisons are
            /// bool.</summary>
            private static Outcome EnumBinary(SyntaxKind kind, Candidate op, object x, object y, bool chk, BinaryExpressionSyntax b)
            {
                BigInteger p = Integer(x), q = Integer(y);
                if (op.Kind == Op.EnumCompare) return Outcome.Of(Compare(kind, p.CompareTo(q), p == q, false)!.Value, typeof(bool));
                Type enumType = op.Result.IsEnum ? op.Result : op.Parameters[0];
                Type underlying = Enum.GetUnderlyingType(enumType);
                BigInteger r = op.Kind switch
                {
                    Op.EnumBits => kind == SyntaxKind.BitwiseAndExpression ? p & q : kind == SyntaxKind.BitwiseOrExpression ? p | q : p ^ q,
                    Op.EnumPlus => p + q,
                    _ => p - q,
                };
                if (!InRange(underlying, r))
                {
                    if (chk) return Outcome.Refuse("the constant expression '" + Text(b) + "' overflows in a checked context");
                    r = Wrap(underlying, r);
                }
                object value = Box(underlying, r);
                return op.Result.IsEnum ? Outcome.Of(Enum.ToObject(op.Result, value), op.Result) : Outcome.Of(value, underlying);
            }

            /// <summary>A comparison's result, or null when <paramref name="kind"/> is not a comparison.</summary>
            private static bool? Compare(SyntaxKind kind, int order, bool equal, bool unordered) => kind switch
            {
                SyntaxKind.EqualsExpression => equal,
                SyntaxKind.NotEqualsExpression => !equal,
                SyntaxKind.LessThanExpression => !unordered && order < 0,
                SyntaxKind.LessThanOrEqualExpression => !unordered && order <= 0,
                SyntaxKind.GreaterThanExpression => !unordered && order > 0,
                SyntaxKind.GreaterThanOrEqualExpression => !unordered && order >= 0,
                _ => null,
            };
        }

        private static bool IsFoldedOperator(SyntaxKind kind) => kind is SyntaxKind.AddExpression or SyntaxKind.SubtractExpression
            or SyntaxKind.MultiplyExpression or SyntaxKind.DivideExpression or SyntaxKind.ModuloExpression
            or SyntaxKind.LeftShiftExpression or SyntaxKind.RightShiftExpression or SyntaxKind.UnsignedRightShiftExpression
            or SyntaxKind.BitwiseAndExpression or SyntaxKind.BitwiseOrExpression or SyntaxKind.ExclusiveOrExpression
            or SyntaxKind.LogicalAndExpression or SyntaxKind.LogicalOrExpression
            or SyntaxKind.EqualsExpression or SyntaxKind.NotEqualsExpression
            or SyntaxKind.LessThanExpression or SyntaxKind.LessThanOrEqualExpression
            or SyntaxKind.GreaterThanExpression or SyntaxKind.GreaterThanOrEqualExpression;

        /// <summary>The predefined numeric and bool operators for <paramref name="kind"/>.</summary>
        private static List<Candidate> Candidates(SyntaxKind kind)
        {
            var list = new List<Candidate>();
            switch (kind)
            {
                case SyntaxKind.AddExpression: case SyntaxKind.SubtractExpression: case SyntaxKind.MultiplyExpression:
                case SyntaxKind.DivideExpression: case SyntaxKind.ModuloExpression:
                    foreach (var t in Arithmetic) list.Add(new Candidate(new[] { t, t }, t, Op.Numeric));
                    break;
                case SyntaxKind.LeftShiftExpression: case SyntaxKind.RightShiftExpression: case SyntaxKind.UnsignedRightShiftExpression:
                    foreach (var t in Integers) list.Add(new Candidate(new[] { t, typeof(int) }, t, Op.Numeric));
                    break;
                case SyntaxKind.BitwiseAndExpression: case SyntaxKind.BitwiseOrExpression: case SyntaxKind.ExclusiveOrExpression:
                    foreach (var t in Integers) list.Add(new Candidate(new[] { t, t }, t, Op.Numeric));
                    list.Add(new Candidate(new[] { typeof(bool), typeof(bool) }, typeof(bool), Op.Bool));
                    break;
                case SyntaxKind.EqualsExpression: case SyntaxKind.NotEqualsExpression:
                    foreach (var t in Arithmetic) list.Add(new Candidate(new[] { t, t }, typeof(bool), Op.Numeric));
                    list.Add(new Candidate(new[] { typeof(bool), typeof(bool) }, typeof(bool), Op.Bool));
                    break;
                case SyntaxKind.LessThanExpression: case SyntaxKind.LessThanOrEqualExpression:
                case SyntaxKind.GreaterThanExpression: case SyntaxKind.GreaterThanOrEqualExpression:
                    foreach (var t in Arithmetic) list.Add(new Candidate(new[] { t, t }, typeof(bool), Op.Numeric));
                    break;
                default: // && ||
                    list.Add(new Candidate(new[] { typeof(bool), typeof(bool) }, typeof(bool), Op.Bool));
                    break;
            }
            return list;
        }

        private static void AddEnumCandidates(SyntaxKind kind, Type e, List<Candidate> list)
        {
            var u = Enum.GetUnderlyingType(e);
            switch (kind)
            {
                case SyntaxKind.BitwiseAndExpression: case SyntaxKind.BitwiseOrExpression: case SyntaxKind.ExclusiveOrExpression:
                    list.Add(new Candidate(new[] { e, e }, e, Op.EnumBits));
                    break;
                case SyntaxKind.EqualsExpression: case SyntaxKind.NotEqualsExpression: case SyntaxKind.LessThanExpression:
                case SyntaxKind.LessThanOrEqualExpression: case SyntaxKind.GreaterThanExpression: case SyntaxKind.GreaterThanOrEqualExpression:
                    list.Add(new Candidate(new[] { e, e }, typeof(bool), Op.EnumCompare));
                    break;
                case SyntaxKind.AddExpression:
                    list.Add(new Candidate(new[] { e, u }, e, Op.EnumPlus));
                    list.Add(new Candidate(new[] { u, e }, e, Op.EnumPlus));
                    break;
                case SyntaxKind.SubtractExpression:
                    list.Add(new Candidate(new[] { e, e }, u, Op.EnumDifference));
                    list.Add(new Candidate(new[] { e, u }, e, Op.EnumMinus));
                    break;
            }
        }

        // ------------------------------------------------------------ overload resolution ------------------------------

        /// <summary>The index of the best applicable candidate; -1 when none applies, -2 when no single one is best.</summary>
        private static int Resolve(List<Candidate> candidates, DesignerConstant[] args)
        {
            var applicable = new List<int>();
            for (int i = 0; i < candidates.Count; i++)
            {
                bool all = true;
                for (int k = 0; k < args.Length && all; k++) all = ConvertsImplicitly(args[k], candidates[i].Parameters[k]);
                if (all) applicable.Add(i);
            }
            if (applicable.Count == 0) return -1;
            foreach (int i in applicable)
                if (applicable.All(j => j == i || Better(candidates[i], candidates[j], args))) return i;
            return -2;
        }

        private static bool Better(Candidate x, Candidate y, DesignerConstant[] args)
        {
            bool better = false;
            for (int k = 0; k < args.Length; k++)
            {
                int c = BetterConversion(args[k].Type!, x.Parameters[k], y.Parameters[k]);
                if (c < 0) return false;
                if (c > 0) better = true;
            }
            return better;
        }

        /// <summary>C#'s better conversion from an expression of type <paramref name="source"/>: an exact match first, then
        /// the better conversion target.</summary>
        private static int BetterConversion(Type source, Type t1, Type t2)
        {
            if (t1 == t2) return 0;
            bool e1 = source == t1, e2 = source == t2;
            if (e1 != e2) return e1 ? 1 : -1;
            bool c12 = ImplicitNumeric(t1, t2), c21 = ImplicitNumeric(t2, t1);
            if (c12 && !c21) return 1;
            if (c21 && !c12) return -1;
            if (SignedBeforeUnsigned(t1, t2)) return 1;
            if (SignedBeforeUnsigned(t2, t1)) return -1;
            return 0;
        }

        private static bool SignedBeforeUnsigned(Type s, Type u) =>
            (s == typeof(sbyte) && (u == typeof(byte) || u == typeof(ushort) || u == typeof(uint) || u == typeof(ulong)))
            || (s == typeof(short) && (u == typeof(ushort) || u == typeof(uint) || u == typeof(ulong)))
            || (s == typeof(int) && (u == typeof(uint) || u == typeof(ulong)))
            || (s == typeof(long) && u == typeof(ulong));

        /// <summary>Whether the constant converts implicitly to <paramref name="to"/>: identity, an implicit numeric
        /// conversion, an int constant to a narrower or unsigned type it fits, a non-negative long constant to ulong, a
        /// numeric zero to an enum, null to string. The compiler takes a zero of any numeric type but char to an enum,
        /// <c>0.0</c> and <c>0m</c> included, as its predecessor did.</summary>
        private static bool ConvertsImplicitly(DesignerConstant c, Type to)
        {
            if (c.Type == to) return true;
            if (c.Type == null) return to == typeof(string);
            if (c.Type.IsEnum || !IsNumeric(c.Type)) return false;
            if (ImplicitNumeric(c.Type, to)) return true;
            if (to.IsEnum)
                return c.Type != typeof(char) && c.Value switch
                {
                    float f => f == 0,
                    double d => d == 0,
                    decimal m => m == 0,
                    _ => Integer(c.Value!).IsZero,
                };
            switch (c.Value)
            {
                case int i:
                    return (to == typeof(sbyte) && i >= sbyte.MinValue && i <= sbyte.MaxValue)
                        || (to == typeof(byte) && i >= byte.MinValue && i <= byte.MaxValue)
                        || (to == typeof(short) && i >= short.MinValue && i <= short.MaxValue)
                        || (to == typeof(ushort) && i >= ushort.MinValue && i <= ushort.MaxValue)
                        || ((to == typeof(uint) || to == typeof(ulong)) && i >= 0);
                case long l:
                    return to == typeof(ulong) && l >= 0;
            }
            return false;
        }

        /// <summary>The implicit numeric conversions between two different types.</summary>
        private static bool ImplicitNumeric(Type from, Type to)
        {
            if (from == to || !IsNumeric(from)) return false;
            if (to == typeof(float) || to == typeof(double) || to == typeof(decimal))
                return IsIntegral(from) || (from == typeof(float) && to == typeof(double));
            if (from == typeof(sbyte)) return to == typeof(short) || to == typeof(int) || to == typeof(long);
            if (from == typeof(byte))
                return to == typeof(short) || to == typeof(ushort) || to == typeof(int) || to == typeof(uint) || to == typeof(long) || to == typeof(ulong);
            if (from == typeof(short)) return to == typeof(int) || to == typeof(long);
            if (from == typeof(ushort) || from == typeof(char))
                return to == typeof(int) || to == typeof(uint) || to == typeof(long) || to == typeof(ulong) || (from == typeof(char) && to == typeof(ushort));
            if (from == typeof(int)) return to == typeof(long);
            if (from == typeof(uint)) return to == typeof(long) || to == typeof(ulong);
            return false;
        }

        // ------------------------------------------------------------------ conversions --------------------------------

        /// <summary>
        /// The constant converted to <paramref name="to"/> as C#'s explicit conversion converts it at compile time. In a
        /// checked context an integral value out of range is an error; unchecked, it keeps its low bits. A floating value
        /// out of an integral type's range is refused in either context: unchecked, C# leaves its result unspecified. A
        /// decimal conversion out of range is an error in either context.
        /// </summary>
        private static bool TryConvert(DesignerConstant c, Type to, bool chk, out DesignerConstant result, out string? refusal)
        {
            result = default;
            refusal = null;
            if (c.Type == to)
            {
                result = c;
                return true;
            }
            if (c.Type == null)
            {
                if (to == typeof(string))
                {
                    result = new DesignerConstant(null, typeof(string));
                    return true;
                }
                refusal = "null cannot be converted to " + Describe(to);
                return false;
            }
            if (!(IsNumeric(c.Type) || c.Type.IsEnum) || !(IsNumeric(to) || to.IsEnum))
            {
                refusal = "a constant of type " + Describe(c.Type) + " cannot be converted to " + Describe(to);
                return false;
            }
            Type target = to.IsEnum ? Enum.GetUnderlyingType(to) : to;
            object source = c.Value is Enum e ? Underlying(e) : c.Value!;
            object value;
            if (target == typeof(float) || target == typeof(double) || target == typeof(decimal))
            {
                try { value = ToFloating(source, target); }
                catch (OverflowException)
                {
                    refusal = "constant value " + Show(c) + " cannot be converted to " + Describe(to);
                    return false;
                }
            }
            else
            {
                BigInteger n;
                if (source is float or double)
                {
                    double d = source is float f ? f : (double)source;
                    if (double.IsNaN(d) || double.IsInfinity(d) || Math.Abs(d) >= 1e30 || !InRange(target, n = new BigInteger(Math.Truncate(d))))
                    {
                        refusal = "constant value " + Show(c) + (chk ? " cannot be converted to " : " converted to ") + Describe(to)
                            + (chk ? "" : " in an unchecked context is unspecified");
                        return false;
                    }
                }
                else if (source is decimal m)
                {
                    if (!InRange(target, n = new BigInteger(decimal.Truncate(m))))
                    {
                        refusal = "constant value " + Show(c) + " cannot be converted to " + Describe(to);
                        return false;
                    }
                }
                else
                {
                    n = Integer(source);
                    if (!InRange(target, n))
                    {
                        if (chk)
                        {
                            refusal = "constant value " + Show(c) + " cannot be converted to " + Describe(to) + " in a checked context";
                            return false;
                        }
                        n = Wrap(target, n);
                    }
                }
                value = Box(target, n);
            }
            result = new DesignerConstant(to.IsEnum ? Enum.ToObject(to, value) : value, to);
            return true;
        }

        /// <summary><paramref name="source"/> (a primitive) converted to float, double or decimal. Each branch boxes its own
        /// type: no conditional may widen a float to double on the way.</summary>
        private static object ToFloating(object source, Type target)
        {
            if (target == typeof(float))
            {
                switch (source)
                {
                    case float f: return f;
                    case double d: return (float)d;
                    case decimal m: return (float)m;
                    // From an integral type in its own width: a long goes to float in one rounding, not through double.
                    case sbyte v: return (float)v;
                    case byte v: return (float)v;
                    case short v: return (float)v;
                    case ushort v: return (float)v;
                    case char v: return (float)v;
                    case int v: return (float)v;
                    case uint v: return (float)v;
                    case long v: return (float)v;
                    default: return (float)(ulong)source;
                }
            }
            if (target == typeof(double))
            {
                switch (source)
                {
                    case float f: return (double)f;
                    case double d: return d;
                    case decimal m: return (double)m;
                    case sbyte v: return (double)v;
                    case byte v: return (double)v;
                    case short v: return (double)v;
                    case ushort v: return (double)v;
                    case char v: return (double)v;
                    case int v: return (double)v;
                    case uint v: return (double)v;
                    case long v: return (double)v;
                    default: return (double)(ulong)source;
                }
            }
            switch (source)
            {
                case float f: return (decimal)f; // float's own conversion (7 significant digits), not through double
                case double d: return (decimal)d;
                case decimal m: return m;
                default: return (decimal)Integer(source);
            }
        }

        // ------------------------------------------------------------------ helpers ------------------------------------

        private static Type? KeywordType(SyntaxKind keyword) => keyword switch
        {
            SyntaxKind.ByteKeyword => typeof(byte), SyntaxKind.SByteKeyword => typeof(sbyte),
            SyntaxKind.ShortKeyword => typeof(short), SyntaxKind.UShortKeyword => typeof(ushort),
            SyntaxKind.IntKeyword => typeof(int), SyntaxKind.UIntKeyword => typeof(uint),
            SyntaxKind.LongKeyword => typeof(long), SyntaxKind.ULongKeyword => typeof(ulong),
            SyntaxKind.FloatKeyword => typeof(float), SyntaxKind.DoubleKeyword => typeof(double),
            SyntaxKind.DecimalKeyword => typeof(decimal), SyntaxKind.CharKeyword => typeof(char),
            SyntaxKind.BoolKeyword => typeof(bool), SyntaxKind.StringKeyword => typeof(string),
            SyntaxKind.ObjectKeyword => typeof(object),
            _ => null,
        };

        /// <summary>Whether an integer literal ends in a suffix with U (u, U, ul, LU, …).</summary>
        private static bool HasUnsignedSuffix(string text)
        {
            for (int i = text.Length - 1; i >= 0 && text[i] is 'u' or 'U' or 'l' or 'L'; i--)
                if (text[i] is 'u' or 'U') return true;
            return false;
        }

        private static bool IsInteger(Type t) =>
            t == typeof(sbyte) || t == typeof(byte) || t == typeof(short) || t == typeof(ushort)
            || t == typeof(int) || t == typeof(uint) || t == typeof(long) || t == typeof(ulong);

        private static bool IsIntegral(Type t) => IsInteger(t) || t == typeof(char);

        private static bool IsNumeric(Type t) => IsIntegral(t) || t == typeof(float) || t == typeof(double) || t == typeof(decimal);

        private static object Underlying(Enum e) =>
            Convert.ChangeType(e, Enum.GetUnderlyingType(e.GetType()), CultureInfo.InvariantCulture);

        /// <summary>An integral value (char and an enum's underlying value included) as an exact integer.</summary>
        private static BigInteger Integer(object value)
        {
            switch (value)
            {
                case sbyte v: return v;
                case byte v: return v;
                case short v: return v;
                case ushort v: return v;
                case char v: return (int)v;
                case int v: return v;
                case uint v: return v;
                case long v: return v;
                case ulong v: return v;
                case Enum e: return Integer(Underlying(e));
                default: throw new InvalidOperationException("not an integral constant: " + value.GetType().FullName);
            }
        }

        private static (BigInteger Min, BigInteger Max) Range(Type t)
        {
            if (t == typeof(sbyte)) return (sbyte.MinValue, sbyte.MaxValue);
            if (t == typeof(byte)) return (byte.MinValue, byte.MaxValue);
            if (t == typeof(short)) return (short.MinValue, short.MaxValue);
            if (t == typeof(ushort) || t == typeof(char)) return (ushort.MinValue, ushort.MaxValue);
            if (t == typeof(int)) return (int.MinValue, int.MaxValue);
            if (t == typeof(uint)) return (uint.MinValue, uint.MaxValue);
            if (t == typeof(long)) return (long.MinValue, long.MaxValue);
            if (t == typeof(ulong)) return (ulong.MinValue, ulong.MaxValue);
            throw new InvalidOperationException("not an integral type: " + t.FullName);
        }

        private static bool InRange(Type t, BigInteger n)
        {
            var (min, max) = Range(t);
            return n >= min && n <= max;
        }

        /// <summary>The low bits of <paramref name="n"/> in the width of <paramref name="t"/>, as C# keeps them unchecked.</summary>
        private static BigInteger Wrap(Type t, BigInteger n)
        {
            var (min, max) = Range(t);
            BigInteger modulus = max - min + 1;
            BigInteger r = BigInteger.Remainder(n - min, modulus);
            if (r < 0) r += modulus;
            return r + min;
        }

        /// <summary><paramref name="n"/>, in range of <paramref name="t"/>, boxed as <paramref name="t"/>.</summary>
        private static object Box(Type t, BigInteger n)
        {
            if (t == typeof(sbyte)) return (sbyte)n;
            if (t == typeof(byte)) return (byte)n;
            if (t == typeof(short)) return (short)n;
            if (t == typeof(ushort)) return (ushort)n;
            if (t == typeof(char)) return (char)(ushort)n;
            if (t == typeof(int)) return (int)n;
            if (t == typeof(uint)) return (uint)n;
            if (t == typeof(long)) return (long)n;
            if (t == typeof(ulong)) return (ulong)n;
            throw new InvalidOperationException("not an integral type: " + t.FullName);
        }

        internal static string Describe(Type? t) =>
            t == null ? "<null>"
            : t == typeof(int) ? "int" : t == typeof(uint) ? "uint" : t == typeof(long) ? "long" : t == typeof(ulong) ? "ulong"
            : t == typeof(short) ? "short" : t == typeof(ushort) ? "ushort" : t == typeof(sbyte) ? "sbyte" : t == typeof(byte) ? "byte"
            : t == typeof(char) ? "char" : t == typeof(float) ? "float" : t == typeof(double) ? "double" : t == typeof(decimal) ? "decimal"
            : t == typeof(bool) ? "bool" : t == typeof(string) ? "string" : t.FullName ?? t.Name;

        private static string Show(DesignerConstant c) => c.Value switch
        {
            null => "null",
            IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
            _ => c.Value.ToString() ?? "",
        };

        private static string Text(Microsoft.CodeAnalysis.SyntaxNode node)
        {
            string text = node.ToString();
            return text.Length <= 120 ? text : text[..117] + "...";
        }
    }
}
