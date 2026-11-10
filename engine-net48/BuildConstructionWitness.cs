using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using WinFormsDesigner.Engine;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// The constructions the project's own build makes in the designed type's InitializeComponent, read from its IL, as
    /// the authority for an <see cref="IrBuildWitnessedCtor"/>. A value of a type no allowlist names (a vendor editor's
    /// button, say) is constructed only through a constructor the build calls there, with the same constant arguments it
    /// passes. Running it is what constructing the compiled form runs anyway; an edited argument, another constructor,
    /// or a construction the build makes elsewhere is refused.
    ///
    /// A call site is witnessed only when every argument is a constant loaded immediately before the <c>newobj</c> (a
    /// widening conversion of that constant included) and no branch, switch or exception handler enters that run of
    /// instructions or the <c>newobj</c> itself: only then are those constants, and nothing else, what the build passes.
    /// </summary>
    internal sealed class BuildConstructionWitness : IIrConstructionWitness
    {
        private readonly List<Site> _sites;

        private BuildConstructionWitness(List<Site> sites) { _sites = sites; }

        /// <summary>True when the build makes at least one construction whose arguments are all constants.</summary>
        public bool HasSites => _sites.Any(site => site.Constants != null);

        internal sealed class Site
        {
            public ConstructorInfo Ctor = default!;
            public Constant[]? Constants;
        }

        /// <summary>A constant as the evaluation stack holds it: an int32 or int64 integer (<see cref="Wide"/>), a
        /// floating value, a string, or null.</summary>
        internal struct Constant
        {
            public bool IsNull;
            public string? Text;
            public bool IsInteger;
            public bool Wide;
            public long Integer;
            public bool IsReal;
            public double Real;
        }

        /// <summary>The witness of <paramref name="designedType"/>'s build. A missing or unreadable InitializeComponent
        /// witnesses nothing.</summary>
        public static BuildConstructionWitness For(Type? designedType)
        {
            try
            {
                var method = designedType?.GetMethod("InitializeComponent",
                    BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly,
                    null, Type.EmptyTypes, null);
                var body = method?.GetMethodBody();
                var il = body?.GetILAsByteArray();
                if (method == null || body == null || il == null) return FromSites(new List<Site>());
                var module = method.Module;
                var typeArguments = designedType!.IsGenericType ? designedType.GetGenericArguments() : null;
                var clauses = body.ExceptionHandlingClauses.Select(clause => new HandlerClause
                {
                    TryOffset = clause.TryOffset,
                    TryLength = clause.TryLength,
                    HandlerOffset = clause.HandlerOffset,
                    FilterOffset = clause.Flags == ExceptionHandlingClauseOptions.Filter ? clause.FilterOffset : -1,
                }).ToList();
                return FromIl(il,
                    token => module.ResolveMethod(token, typeArguments, null) as ConstructorInfo,
                    token => module.ResolveString(token),
                    clauses);
            }
            catch
            {
                return FromSites(new List<Site>());
            }
        }

        /// <summary>One exception-handling clause of the method: its protected range and where its handler (and filter,
        /// or -1) begins.</summary>
        internal struct HandlerClause
        {
            public int TryOffset;
            public int TryLength;
            public int HandlerOffset;
            public int FilterOffset;
        }

        /// <summary>The witness of a method body given as IL, its token resolvers and its exception-handling clauses.
        /// IL that does not decode witnesses nothing.</summary>
        internal static BuildConstructionWitness FromIl(byte[] il, Func<int, ConstructorInfo?> resolveConstructor,
            Func<int, string?> resolveString, IEnumerable<HandlerClause> clauses) =>
            FromSites(Read(il, resolveConstructor, resolveString, (clauses ?? Enumerable.Empty<HandlerClause>()).ToList())
                ?? new List<Site>());

        private static BuildConstructionWitness FromSites(List<Site> sites) => new BuildConstructionWitness(sites);

        public bool CanConstruct(Type type, object?[] args, out string reason) => Match(type, args, out _, out reason);

        public bool TryConstruct(Type type, object?[] args, out object? value, out string reason)
        {
            value = null;
            if (!Match(type, args, out var ctor, out reason)) return false;
            value = ctor!.Invoke(args);
            return true;
        }

        private bool Match(Type type, object?[] args, out ConstructorInfo? match, out string reason)
        {
            match = null;
            // A null argument does not name a parameter type: C# binds it to the most specific applicable overload —
            // through optional parameters, params arrays and params collections alike — which need not be the one the
            // build calls with null. Only a type with a single instance constructor leaves C# no other choice.
            var constructors = type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
            if (args.Any(arg => arg == null) && constructors.Length != 1)
            {
                reason = "a null argument does not identify one constructor of " + type.FullName;
                return false;
            }
            // With every argument of exactly its parameter's type, C# binds the constructor with those parameter types —
            // unless an overload resolution priority says otherwise, which nothing here models.
            if (constructors.Any(c => c.GetCustomAttributesData().Any(a =>
                    a.AttributeType.FullName == "System.Runtime.CompilerServices.OverloadResolutionPriorityAttribute")))
            {
                reason = type.FullName + " gives its constructors overload resolution priorities";
                return false;
            }
            // Custom modifiers can tell apart overloads whose parameter types read the same, and C# breaks that tie by
            // them; nothing here sees them, so a type that uses them is not taken.
            if (constructors.Any(c => c.GetParameters().Any(p =>
                    p.GetOptionalCustomModifiers().Length != 0 || p.GetRequiredCustomModifiers().Length != 0)))
            {
                reason = type.FullName + " has constructors told apart by custom modifiers";
                return false;
            }
            foreach (var site in _sites)
            {
                if (site.Constants == null || site.Constants.Length != args.Length) continue;
                var declaring = site.Ctor.DeclaringType;
                // The same constructor of the same build of that type, wherever the resolver loaded it from: its module
                // and metadata identity, then the constructor of the type the replay itself resolved.
                if (declaring == null || declaring.MetadataToken != type.MetadataToken
                    || declaring.Module.ModuleVersionId != type.Module.ModuleVersionId) continue;
                var ctor = type.GetConstructors(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                    .FirstOrDefault(c => c.MetadataToken == site.Ctor.MetadataToken);
                if (ctor == null) continue;
                var parameters = ctor.GetParameters();
                bool same = parameters.Length == args.Length;
                for (int i = 0; i < parameters.Length && same; i++)
                    same = Takes(parameters[i].ParameterType, args[i]) && Same(parameters[i].ParameterType, args[i], site.Constants[i]);
                if (!same) continue;
                match = ctor;
                reason = "";
                return true;
            }
            reason = "the project's build does not construct " + type.FullName + " with these arguments in InitializeComponent";
            return false;
        }

        /// <summary>The argument is exactly of the parameter's type, or null for a reference parameter: no conversion
        /// stands between the value the source wrote and the one the build passes.</summary>
        private static bool Takes(Type parameter, object? arg) =>
            arg == null ? !parameter.IsValueType : arg.GetType() == parameter;

        private static bool Same(Type parameter, object? arg, Constant built)
        {
            if (arg == null) return built.IsNull;
            if (built.IsNull) return false;
            if (arg is string s) return built.Text != null && string.Equals(s, built.Text, StringComparison.Ordinal);
            if (built.Text != null) return false;
            if (arg is float f) return built.IsReal && BitConverter.DoubleToInt64Bits((float)built.Real) == BitConverter.DoubleToInt64Bits(f);
            if (arg is double d) return built.IsReal && BitConverter.DoubleToInt64Bits(built.Real) == BitConverter.DoubleToInt64Bits(d);
            if (!built.IsInteger) return false;
            Type integral = parameter.IsEnum ? Enum.GetUnderlyingType(parameter) : parameter;
            long value;
            switch (arg)
            {
                case bool b: value = b ? 1 : 0; break;
                case char c: value = c; break;
                case Enum e when integral == typeof(ulong): value = unchecked((long)Convert.ToUInt64(e)); break;
                case Enum e: value = Convert.ToInt64(e); break;
                case ulong ul: value = unchecked((long)ul); break;
                case IConvertible n when integral != typeof(decimal):
                    try { value = Convert.ToInt64(n); } catch (OverflowException) { return false; }
                    break;
                default: return false;
            }
            // A 64-bit parameter takes an int64 from the stack; anything narrower an int32, whose bits are compared
            // (`uint.MaxValue` is ldc.i4.m1).
            bool wide = integral == typeof(long) || integral == typeof(ulong);
            if (wide != built.Wide) return false;
            return wide ? value == built.Integer : unchecked((int)value) == unchecked((int)built.Integer);
        }

        // ------------------------------------------------------------------ IL ------------------------------------

        private static readonly OpCode[] OneByte = new OpCode[256];
        private static readonly OpCode[] TwoByte = new OpCode[256];
        private static readonly bool[] OneByteKnown = new bool[256];
        private static readonly bool[] TwoByteKnown = new bool[256];

        static BuildConstructionWitness()
        {
            foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
            {
                if (field.GetValue(null) is not OpCode op) continue;
                ushort code = unchecked((ushort)op.Value);
                if (op.Size == 1) { OneByte[code] = op; OneByteKnown[code] = true; }
                else if ((code >> 8) == 0xFE) { TwoByte[code & 0xFF] = op; TwoByteKnown[code & 0xFF] = true; }
            }
        }

        private struct Instruction
        {
            public int Offset;
            public OpCode Op;
            public int Operand;
            public int Next;
        }

        /// <summary>Every <c>newobj</c> of the method with its constant arguments (null when they are not provably the
        /// constants listed before it), or null when the IL does not decode.</summary>
        private static List<Site>? Read(byte[] il, Func<int, ConstructorInfo?> resolveConstructor,
            Func<int, string?> resolveString, List<HandlerClause> clauses)
        {
            var instructions = Decode(il);
            if (instructions == null) return null;

            // Every offset control reaches other than by falling through from the previous instruction.
            var entered = new HashSet<int>();
            foreach (var clause in clauses)
            {
                entered.Add(clause.TryOffset);
                entered.Add(clause.HandlerOffset);
                if (clause.FilterOffset >= 0) entered.Add(clause.FilterOffset);
            }
            foreach (var ins in instructions)
            {
                switch (ins.Op.OperandType)
                {
                    case OperandType.ShortInlineBrTarget:
                        entered.Add(ins.Next + unchecked((sbyte)il[ins.Operand]));
                        break;
                    case OperandType.InlineBrTarget:
                        entered.Add(ins.Next + BitConverter.ToInt32(il, ins.Operand));
                        break;
                    case OperandType.InlineSwitch:
                        int count = BitConverter.ToInt32(il, ins.Operand);
                        for (int i = 0; i < count; i++) entered.Add(ins.Next + BitConverter.ToInt32(il, ins.Operand + 4 + 4 * i));
                        break;
                }
            }

            var reachable = Reachable(instructions, il, clauses);
            var sites = new List<Site>();
            var pending = new List<Constant>();
            foreach (var ins in instructions)
            {
                // Code no path reaches is not something the build does.
                if (!reachable.Contains(ins.Offset)) { pending.Clear(); continue; }
                // Another edge can arrive here with other values on the stack: what was listed before is not what
                // this instruction consumes.
                if (entered.Contains(ins.Offset)) pending.Clear();
                var op = ins.Op;
                if (TryConstant(op, il, ins.Operand, resolveString, out var constant)) { pending.Add(constant); continue; }
                if (op == OpCodes.Nop) continue;
                if (pending.Count != 0 && TryConvert(op, pending[pending.Count - 1], out var converted))
                {
                    pending[pending.Count - 1] = converted;
                    continue;
                }
                if (op == OpCodes.Newobj)
                {
                    ConstructorInfo? ctor;
                    try { ctor = resolveConstructor(BitConverter.ToInt32(il, ins.Operand)); }
                    catch { ctor = null; }
                    if (ctor != null)
                    {
                        int count = ctor.GetParameters().Length;
                        sites.Add(new Site
                        {
                            Ctor = ctor,
                            Constants = pending.Count >= count ? pending.GetRange(pending.Count - count, count).ToArray() : null,
                        });
                    }
                }
                pending.Clear();
            }
            return sites;
        }

        /// <summary>The offsets control can reach from the method's entry: through fall-through (except after an
        /// unconditional branch, a return or a throw), branches and switch targets, and into a handler (or filter) only
        /// once an instruction its protected range covers is reached.</summary>
        private static HashSet<int> Reachable(List<Instruction> instructions, byte[] il, List<HandlerClause> clauses)
        {
            var index = new Dictionary<int, int>();
            for (int i = 0; i < instructions.Count; i++) index[instructions[i].Offset] = i;
            var reached = new HashSet<int>();
            var pending = new Stack<int>();
            var rooted = new HashSet<int>();
            pending.Push(0);
            while (true)
            {
                Walk(instructions, il, index, reached, pending);
                bool more = false;
                for (int c = 0; c < clauses.Count; c++)
                {
                    var clause = clauses[c];
                    if (rooted.Contains(c) || !reached.Any(o => o >= clause.TryOffset && o < clause.TryOffset + clause.TryLength)) continue;
                    rooted.Add(c);
                    pending.Push(clause.HandlerOffset);
                    if (clause.FilterOffset >= 0) pending.Push(clause.FilterOffset);
                    more = true;
                }
                if (!more) return reached;
            }
        }

        private static void Walk(List<Instruction> instructions, byte[] il, Dictionary<int, int> index, HashSet<int> reached, Stack<int> pending)
        {
            while (pending.Count != 0)
            {
                int offset = pending.Pop();
                if (!index.TryGetValue(offset, out int at) || !reached.Add(offset)) continue;
                var ins = instructions[at];
                var flow = ins.Op.FlowControl;
                switch (ins.Op.OperandType)
                {
                    case OperandType.ShortInlineBrTarget: pending.Push(ins.Next + unchecked((sbyte)il[ins.Operand])); break;
                    case OperandType.InlineBrTarget: pending.Push(ins.Next + BitConverter.ToInt32(il, ins.Operand)); break;
                    case OperandType.InlineSwitch:
                        int count = BitConverter.ToInt32(il, ins.Operand);
                        for (int i = 0; i < count; i++) pending.Push(ins.Next + BitConverter.ToInt32(il, ins.Operand + 4 + 4 * i));
                        break;
                }
                // `jmp` leaves the method for good although its flow kind reads as a call.
                if (flow != FlowControl.Branch && flow != FlowControl.Return && flow != FlowControl.Throw && ins.Op != OpCodes.Jmp)
                    pending.Push(ins.Next);
            }
        }

        private static List<Instruction>? Decode(byte[] il)
        {
            var instructions = new List<Instruction>();
            int pos = 0;
            while (pos < il.Length)
            {
                int offset = pos;
                OpCode op;
                byte first = il[pos++];
                if (first == 0xFE)
                {
                    if (pos >= il.Length || !TwoByteKnown[il[pos]]) return null;
                    op = TwoByte[il[pos++]];
                }
                else
                {
                    if (!OneByteKnown[first]) return null;
                    op = OneByte[first];
                }
                int size = OperandSize(op.OperandType, il, pos);
                if (size < 0 || pos + size > il.Length) return null;
                instructions.Add(new Instruction { Offset = offset, Op = op, Operand = pos, Next = pos + size });
                pos += size;
            }
            return instructions;
        }

        private static bool TryConstant(OpCode op, byte[] il, int operand, Func<int, string?> resolveString, out Constant constant)
        {
            constant = default;
            if (op == OpCodes.Ldnull) { constant.IsNull = true; return true; }
            if (op == OpCodes.Ldstr)
            {
                string? text;
                try { text = resolveString(BitConverter.ToInt32(il, operand)); } catch { text = null; }
                if (text == null) return false;
                constant.Text = text;
                return true;
            }
            int? small =
                op == OpCodes.Ldc_I4_M1 ? -1 : op == OpCodes.Ldc_I4_0 ? 0 : op == OpCodes.Ldc_I4_1 ? 1
                : op == OpCodes.Ldc_I4_2 ? 2 : op == OpCodes.Ldc_I4_3 ? 3 : op == OpCodes.Ldc_I4_4 ? 4
                : op == OpCodes.Ldc_I4_5 ? 5 : op == OpCodes.Ldc_I4_6 ? 6 : op == OpCodes.Ldc_I4_7 ? 7
                : op == OpCodes.Ldc_I4_8 ? 8 : (int?)null;
            if (small != null) { constant.IsInteger = true; constant.Integer = small.Value; return true; }
            if (op == OpCodes.Ldc_I4_S) { constant.IsInteger = true; constant.Integer = unchecked((sbyte)il[operand]); return true; }
            if (op == OpCodes.Ldc_I4) { constant.IsInteger = true; constant.Integer = BitConverter.ToInt32(il, operand); return true; }
            if (op == OpCodes.Ldc_I8) { constant.IsInteger = true; constant.Wide = true; constant.Integer = BitConverter.ToInt64(il, operand); return true; }
            if (op == OpCodes.Ldc_R4) { constant.IsReal = true; constant.Real = BitConverter.ToSingle(il, operand); return true; }
            if (op == OpCodes.Ldc_R8) { constant.IsReal = true; constant.Real = BitConverter.ToDouble(il, operand); return true; }
            return false;
        }

        /// <summary>The conversions the compiler emits to widen a constant to its parameter's type, applied as the
        /// runtime applies them to the stack value; any other conversion makes the value unknown.</summary>
        private static bool TryConvert(OpCode op, Constant value, out Constant converted)
        {
            converted = value;
            if (value.IsNull || value.Text != null) return false;
            if (op == OpCodes.Conv_I8 && value.IsInteger)
            {
                // int32 sign-extends (the stored value already is); int64 is unchanged.
                converted.Wide = true;
                return true;
            }
            if (op == OpCodes.Conv_U8 && value.IsInteger)
            {
                // int32 zero-extends; int64 keeps its bits.
                if (!value.Wide) converted.Integer = unchecked((long)(uint)value.Integer);
                converted.Wide = true;
                return true;
            }
            if (op == OpCodes.Conv_R8)
            {
                if (value.IsReal) return true;
                if (!value.IsInteger) return false;
                double real = value.Integer;
                converted = new Constant { IsReal = true, Real = real };
                return true;
            }
            if (op == OpCodes.Conv_R4)
            {
                float single = value.IsInteger ? value.Integer : value.IsReal ? (float)value.Real : float.NaN;
                if (!value.IsInteger && !value.IsReal) return false;
                converted = new Constant { IsReal = true, Real = single };
                return true;
            }
            return false;
        }

        private static int OperandSize(OperandType type, byte[] il, int pos)
        {
            switch (type)
            {
                case OperandType.InlineNone: return 0;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar: return 1;
                case OperandType.InlineVar: return 2;
                case OperandType.InlineBrTarget:
                case OperandType.InlineField:
                case OperandType.InlineI:
                case OperandType.InlineMethod:
                case OperandType.InlineSig:
                case OperandType.InlineString:
                case OperandType.InlineTok:
                case OperandType.InlineType:
                case OperandType.ShortInlineR: return 4;
                case OperandType.InlineI8:
                case OperandType.InlineR: return 8;
                case OperandType.InlineSwitch:
                    if (pos + 4 > il.Length) return -1;
                    int count = BitConverter.ToInt32(il, pos);
                    return count < 0 || count > (il.Length - pos - 4) / 4 ? -1 : 4 + 4 * count;
                default: return -1;
            }
        }
    }

    /// <summary>The replay's host with the build's witness beside it: every <see cref="IIrHost"/> service is the inner
    /// host's, and an <see cref="IrBuildWitnessedCtor"/> is decided by the witness.</summary>
    internal sealed class WitnessedIrHost : IIrHost, IIrConstructionWitness
    {
        private readonly IIrHost _inner;
        private readonly IIrConstructionWitness _witness;

        public WitnessedIrHost(IIrHost inner, IIrConstructionWitness witness) { _inner = inner; _witness = witness; }

        public Type? ResolveType(string typeName) => _inner.ResolveType(typeName);
        public object CreateComponent(Type type, string name, bool withContainer) => _inner.CreateComponent(type, name, withContainer);
        public object? ResolveResource(string key, bool isString) => _inner.ResolveResource(key, isString);
        public bool WasResourceRefused(string key) => _inner.WasResourceRefused(key);
        public bool HasResource(string key) => _inner.HasResource(key);
        public bool HasResourceSet => _inner.HasResourceSet;
        public bool ApplyResources(object target, string key, out string? error) => _inner.ApplyResources(target, key, out error);
        public bool CanConstruct(Type type, object?[] args, out string reason) => _witness.CanConstruct(type, args, out reason);
        public bool TryConstruct(Type type, object?[] args, out object? value, out string reason) =>
            _witness.TryConstruct(type, args, out value, out reason);
    }
}
