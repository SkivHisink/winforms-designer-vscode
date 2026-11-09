using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace WinFormsDesigner.Engine
{
    /// <summary>One step a statement takes, as both its source and its compiled IL show it, in evaluation order: a
    /// constant (its value, and its type where the IL tells it: an enum it is passed or stored as, the type it is boxed
    /// as), a construction of a type, a static member (getter, field, method) of a type, an instance member by name (and
    /// by declaring type where the source names it, through a cast), an array of an element type, a cast to a class or
    /// value type, a type token, a delegate creation.</summary>
    internal readonly record struct DesignerOp(string Kind, Type? Type, string Name, object? Value)
    {
        public static DesignerOp Constant(object? value, Type? type = null) => new("const", type, "", value);
        /// <summary>A constant as the IL loads it; <paramref name="narrow"/> for a 32-bit load.</summary>
        public static DesignerOp Compiled(object? value, bool narrow) => new("const", null, narrow ? "i4" : "", value);
        public static DesignerOp New(Type type) => new("new", type, "", null);
        public static DesignerOp Static(Type declaring, string name) => new("static", declaring, name, null);
        public static DesignerOp Instance(string name, Type? declaring = null) => new("inst", declaring, name, null);
        public static DesignerOp NewArray(Type element) => new("newarr", element, "", null);
        public static DesignerOp Cast(Type type) => new("cast", type, "", null);
        public static DesignerOp Token(Type type) => new("token", type, "", null);
        public static readonly DesignerOp Delegate = new("delegate", null, "", null);

        /// <summary>Whether this step, derived from the source, is the step <paramref name="compiled"/> the build took.
        /// An instance member the source reaches without naming its type matches by name. A constant matches by value
        /// — a number whatever width the compiler loaded it with, a decimal by its value — and by type wherever the IL
        /// tells the type; an enum constant whose type the IL does not tell does not match.</summary>
        public bool Matches(DesignerOp compiled)
        {
            if (Kind != compiled.Kind) return false;
            if (Kind == "const")
                return SameConstant(Value, compiled.Value, compiled.Name == "i4")
                    && (compiled.Type == null ? Type == null || !Type.IsEnum : Type == compiled.Type);
            if (Name != compiled.Name) return false;
            if (Kind == "inst") return Type == null || Type == compiled.Type;
            return Type == compiled.Type;
        }

        private static bool SameConstant(object? source, object? compiled, bool narrow)
        {
            if (source == DesignerBuildEvidence.Unknown || compiled == DesignerBuildEvidence.Unknown) return false;
            if (source == null || compiled == null) return source == null && compiled == null;
            if (source is string s) return compiled is string c && string.Equals(s, c, StringComparison.Ordinal);
            if (compiled is string) return false;
            if (source is decimal || compiled is decimal) return source is decimal m && compiled is decimal n && m == n;
            // Bit for bit: a negative zero is not the zero the compiler stored.
            if (source is double || compiled is double)
                return BitConverter.DoubleToInt64Bits(Convert.ToDouble(source)) == BitConverter.DoubleToInt64Bits(Convert.ToDouble(compiled));
            long a = Convert.ToInt64(source), b = Convert.ToInt64(compiled);
            if (a == b) return true;
            // `ldc.i4` loads a 32-bit constant, an unsigned one as its signed bit pattern; a wider one needs `ldc.i8`.
            return narrow && a >= int.MinValue && a <= uint.MaxValue && unchecked((int)a == (int)b);
        }
    }

    /// <summary>What a source statement must compile to, from <see cref="DesignerTypeScope"/>: its steps in evaluation
    /// order (null when it has a shape that cannot be compared), and the first name it leaves to inference.</summary>
    internal sealed class DesignerSourceStatement
    {
        public List<DesignerOp>? Ops;
        public string? InferredName;
        /// <summary>A name in a type or receiver position the scope could not bind, and why: whatever accepts the
        /// statement by its shape alone must not run it.</summary>
        public string? UnboundName, UnboundReason;
    }

    /// <summary>
    /// What the project's own build compiled <c>InitializeComponent</c> to — the compiler's answer for every name the
    /// designer file leaves unqualified. Read from the IL of the loaded build of the form: metadata and IL bytes only,
    /// never an invoke, a getter, a constructor or a type initializer.
    ///
    /// The IL is cut where the evaluation stack is empty, which is where C# statements begin and end; an optimized
    /// build may keep a value on the stack across several statements, and then one piece holds all of them. Each piece is
    /// paired with the source statement it ends with, by the field that statement starts from and the member it
    /// finally sets, adds to or calls, in order. A statement that names a type by inference is CONFIRMED only when the
    /// steps it must compile to — every constant with its value and type, every construction, static getter, field,
    /// method, instance member, array, cast and type token, in evaluation order — are exactly the steps of its piece,
    /// or, for a piece holding several statements, of that run of statements in order. An alias the designer could not
    /// see changes some step: a different getter, a different type's method, a property call, another value or another
    /// enum where an enum constant was expected, constructions in another order, a call through another interface. The
    /// statement is then refused before anything of it runs. A control is also confirmed by the type stored into its field.
    ///
    /// Anything incomplete — no build, no body, a branch, an opcode or token that cannot be read, a statement the build
    /// does not show — refuses what needs confirming. Instances live for one interpretation only, so no
    /// <see cref="Type"/> of the collectible user context is held beyond it.
    /// </summary>
    internal sealed class DesignerBuildEvidence
    {
        /// <summary>Why there is no evidence; null when the build of InitializeComponent was read completely.</summary>
        public string? Unavailable { get; private set; }

        private sealed class Piece
        {
            public string Receiver = "";
            public string Final = "";
            public readonly List<DesignerOp> Ops = new();
        }

        private readonly Dictionary<string, List<Type>> _fieldConstructions = new(StringComparer.Ordinal);
        private readonly List<Piece> _pieces = new();
        private readonly Dictionary<StatementSyntax, string?> _verdicts = new();

        private const int MaxIlBytes = 16 * 1024 * 1024;
        private const int MaxSwitchTargets = 65536;

        private static readonly OpCode[] OneByte = new OpCode[0x100];
        private static readonly OpCode[] TwoByte = new OpCode[0x100];
        private static readonly bool[] OneByteKnown = new bool[0x100];
        private static readonly bool[] TwoByteKnown = new bool[0x100];

        static DesignerBuildEvidence()
        {
            foreach (var field in typeof(OpCodes).GetFields(BindingFlags.Public | BindingFlags.Static))
            {
                if (field.GetValue(null) is not OpCode op) continue;
                ushort value = (ushort)op.Value;
                if (op.Size == 1) { OneByte[value] = op; OneByteKnown[value] = true; }
                else if ((value & 0xFF00) == 0xFE00) { TwoByte[value & 0xFF] = op; TwoByteKnown[value & 0xFF] = true; }
            }
        }

        private DesignerBuildEvidence() { }

        /// <summary>Read the build of <paramref name="compiledDesigned"/> and decide, for each statement of
        /// <paramref name="source"/> (the InitializeComponent being interpreted), whether the build confirms it.</summary>
        public static DesignerBuildEvidence For(Type? compiledDesigned, IReadOnlyList<StatementSyntax> source,
            ISet<string> fields, Func<StatementSyntax, DesignerSourceStatement> describe)
        {
            var evidence = new DesignerBuildEvidence();
            if (compiledDesigned == null)
            {
                evidence.Unavailable = "the project has not been built; build the project";
                return evidence;
            }
            try
            {
                evidence.Read(compiledDesigned);
                evidence.Judge(source, fields, describe);
            }
            catch (Exception ex)
            {
                evidence.Unavailable = "the project's build of InitializeComponent could not be read ("
                    + ex.GetType().Name + "); build the project";
            }
            return evidence;
        }

        /// <summary>The one type the build stores into <paramref name="field"/> with <c>newobj</c>, or a refusal.</summary>
        public Type? ConstructedInto(string field, out string? refusal)
        {
            refusal = Unavailable;
            if (refusal != null) return null;
            if (!_fieldConstructions.TryGetValue(field, out var types))
            {
                refusal = "the project's last build does not create " + field + "; build the project";
                return null;
            }
            var distinct = types.Distinct().ToList();
            if (distinct.Count != 1)
            {
                refusal = "the project's last build creates " + field + " as more than one type";
                return null;
            }
            return distinct[0];
        }

        /// <summary>Null when the build confirms <paramref name="statement"/>; otherwise why it does not.</summary>
        public string? Verdict(StatementSyntax? statement)
        {
            if (Unavailable != null) return Unavailable;
            if (statement != null && _verdicts.TryGetValue(statement, out var verdict)) return verdict;
            return "the project's last build does not show this statement; build the project";
        }

        // ------------------------------------------------------------------ judging -------------------------------

        private readonly Dictionary<(Type Declaring, string Name), int> _callsOnThis = new();

        /// <summary>How many <c>call</c>/<c>callvirt</c> instructions of the build's InitializeComponent call an instance
        /// method <paramref name="name"/> that <paramref name="declaring"/> declares on the form itself: the receiver is
        /// <c>ldarg.0</c>, not a field, a local or a cast of it.</summary>
        public int CallsOnThis(Type declaring, string name) =>
            _callsOnThis.TryGetValue((declaring, name), out int count) ? count : 0;

        private void Judge(IReadOnlyList<StatementSyntax> source, ISet<string> fields,
            Func<StatementSyntax, DesignerSourceStatement> describe)
        {
            var described = source.Select(describe).ToList();
            var paired = new Piece?[source.Count];
            var byKey = new Dictionary<(string, string), List<int>>();
            for (int k = 0; k < source.Count; k++)
            {
                if (TargetOf(source[k], fields) is not { } key) continue;
                if (!byKey.TryGetValue(key, out var list)) byKey[key] = list = new List<int>();
                list.Add(k);
            }
            var compiled = _pieces.GroupBy(p => (p.Receiver, p.Final)).ToDictionary(g => g.Key, g => g.ToList());
            foreach (var pair in byKey)
            {
                if (!compiled.TryGetValue(pair.Key, out var pieces) || pieces.Count != pair.Value.Count) continue;
                for (int i = 0; i < pieces.Count; i++) paired[pair.Value[i]] = pieces[i];
            }

            for (int k = 0; k < source.Count; k++)
            {
                if (paired[k] is not { } piece) continue;
                // The statement alone, or with the statements right before it that have no piece of their own (an
                // optimized build kept a value on the stack across them): the steps, in order, must be exactly the
                // piece's.
                var run = new List<DesignerOp>();
                for (int j = k; j >= 0; j--)
                {
                    if (j < k && paired[j] != null) break;
                    if (described[j].Ops is not { } ops) break;
                    run.InsertRange(0, ops);
                    if (run.Count > piece.Ops.Count) break;
                    if (run.Count == piece.Ops.Count && run.Zip(piece.Ops, (mine, built) => mine.Matches(built)).All(m => m))
                    {
                        for (int m = j; m <= k; m++) _verdicts[source[m]] = null;
                        break;
                    }
                }
                if (!_verdicts.ContainsKey(source[k]))
                    _verdicts[source[k]] = "the project's last build compiled this statement differently; build the project";
            }
        }

        // ------------------------------------------------------------------ reading -------------------------------

        /// <summary>A value on the evaluation stack the reading can still tell: a constant (as <see cref="ConstantOf"/>
        /// gives it, or a decimal), an array with its element type and, while every store into it is constant, its
        /// elements; anything else is <see cref="Unknown"/>.</summary>
        private sealed class ArrayValue
        {
            public Type Element = typeof(object);
            public object?[]? Items;
        }

        /// <summary>A value the reading cannot tell; as a constant step it matches nothing.</summary>
        internal static readonly object Unknown = new();

        private const int MaxTrackedArray = 4096;

        private void Read(Type designed)
        {
            var init = designed.GetMethod("InitializeComponent",
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly,
                null, Type.EmptyTypes, null);
            if (init == null) throw new MissingMethodException(designed.FullName, "InitializeComponent");
            var body = init.GetMethodBody() ?? throw new InvalidOperationException("no method body");
            byte[] il = body.GetILAsByteArray() ?? throw new InvalidOperationException("no method body");
            if (il.Length > MaxIlBytes) throw new InvalidOperationException("method body too large");
            var locals = body.LocalVariables;
            Type[]? typeArgs = designed.IsGenericType ? designed.GetGenericArguments() : null;
            var module = init.Module;

            Piece? current = null;
            // For each value on the evaluation stack, the index of the first step of the piece that computed it — so
            // the steps of an argument, an array length or an index can be told apart from the rest — and the value
            // itself where it is a constant or a constant array.
            var starts = new List<int>();
            var values = new List<object?>();
            // Whether the value is the form itself as `ldarg.0` loads it (or a `dup` of it); a field, a cast or anything
            // else is not.
            var isThis = new List<bool>();
            int position = 0;
            OpCode previous = OpCodes.Nop;
            Type? previousConstructed = null;
            for (int i = 0; i < il.Length; )
            {
                OpCode op;
                if (il[i] == 0xFE)
                {
                    if (i + 1 >= il.Length || !TwoByteKnown[il[i + 1]]) throw new InvalidOperationException("unknown opcode");
                    op = TwoByte[il[i + 1]];
                    i += 2;
                }
                else
                {
                    if (!OneByteKnown[il[i]]) throw new InvalidOperationException("unknown opcode");
                    op = OneByte[il[i]];
                    i += 1;
                }
                // The designer writes straight-line statements; a branch, a throw or a prefix makes the pieces
                // unprovable.
                if (op.FlowControl is FlowControl.Branch or FlowControl.Cond_Branch or FlowControl.Throw
                    || op.OpCodeType == OpCodeType.Prefix)
                    throw new InvalidOperationException("InitializeComponent is not straight-line");

                int operandStart = i;
                int operand = op.OperandType switch
                {
                    OperandType.InlineNone => 0,
                    OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
                    OperandType.InlineVar => 2,
                    OperandType.InlineI8 or OperandType.InlineR => 8,
                    OperandType.InlineSwitch => SwitchOperandSize(il, i),
                    _ => 4,
                };
                if (i + operand > il.Length) throw new InvalidOperationException("truncated operand");
                int token = operand == 4 ? BitConverter.ToInt32(il, i) : 0;
                i += operand;

                if (op == OpCodes.Nop || op == OpCodes.Ret)
                {
                    if (current != null) throw new InvalidOperationException("unbalanced stack");
                    previous = op;
                    previousConstructed = null;
                    continue;
                }
                if (current == null)
                {
                    current = new Piece();
                    position = 0;
                }

                MethodBase? method = op.OperandType == OperandType.InlineMethod
                    ? module.ResolveMethod(token, typeArgs, null) ?? throw new InvalidOperationException("unresolved method token")
                    : null;
                FieldInfo? field = op.OperandType == OperandType.InlineField
                    ? module.ResolveField(token, typeArgs, null) ?? throw new InvalidOperationException("unresolved field token")
                    : null;
                Type? operandType = op.OperandType == OperandType.InlineType ? module.ResolveType(token, typeArgs, null) : null;

                int pops = Pops(op, method);
                if (pops > starts.Count) throw new InvalidOperationException("unbalanced stack");
                var popped = starts.GetRange(starts.Count - pops, pops);
                var poppedValues = values.GetRange(values.Count - pops, pops);
                var poppedThis = isThis.GetRange(isThis.Count - pops, pops);
                starts.RemoveRange(starts.Count - pops, pops);
                values.RemoveRange(values.Count - pops, pops);
                isThis.RemoveRange(isThis.Count - pops, pops);
                int here = current.Ops.Count;
                int start = popped.Count > 0 ? Math.Min(popped.Min(), here) : here;

                // A constant takes the type of what consumes it where that type is told: a parameter, field, local or
                // array element of an enum type, or the type a box makes of it.
                for (int k = 0; k < pops; k++)
                {
                    Type? consumer = ConsumerType(op, k, method, field, operandType, poppedValues, locals, il, operandStart);
                    if (consumer == null) continue;
                    int from = popped[k], to = k + 1 < pops ? popped[k + 1] : here;
                    if (to - from == 1 && current.Ops[from].Kind == "const" && current.Ops[from].Type == null)
                        current.Ops[from] = current.Ops[from] with { Type = consumer };
                }

                object? pushed = Unknown;
                if (ConstantOf(op, il, operandStart, module, out object? constant))
                {
                    current.Ops.Add(DesignerOp.Compiled(constant, IsNarrowLoad(op)));
                    pushed = constant;
                }
                else if (op == OpCodes.Dup && poppedValues.Count == 1) pushed = poppedValues[0];

                Type? constructedHere = null;
                switch (op.OperandType)
                {
                    case OperandType.InlineMethod:
                        {
                            if (op == OpCodes.Ldftn || op == OpCodes.Ldvirtftn) break;
                            var declaring = method!.DeclaringType ?? throw new InvalidOperationException("method without a type");
                            if (method.IsConstructor)
                            {
                                if (op == OpCodes.Newobj) constructedHere = declaring;
                                if (declaring == typeof(decimal))
                                {
                                    // A decimal is a constant to the source, whatever the compiler built it from (an int,
                                    // constant words, an int array): one constant step with its value.
                                    decimal? built = op == OpCodes.Newobj ? DecimalOf((ConstructorInfo)method, poppedValues) : null;
                                    current.Ops.RemoveRange(start, current.Ops.Count - start);
                                    current.Ops.Add(DesignerOp.Compiled(built.HasValue ? built.Value : Unknown, false));
                                    if (built.HasValue) pushed = built.Value;
                                }
                                else current.Ops.Add(typeof(Delegate).IsAssignableFrom(declaring) ? DesignerOp.Delegate : DesignerOp.New(declaring));
                            }
                            else
                            {
                                current.Ops.Add(declaring == typeof(decimal) ? DesignerOp.Compiled(Unknown, false)
                                    : method.IsStatic ? DesignerOp.Static(declaring, method.Name) : DesignerOp.Instance(method.Name, declaring));
                                current.Final = MemberKey(method.Name);
                                if (!method.IsStatic && (op == OpCodes.Call || op == OpCodes.Callvirt) && poppedThis[0])
                                    _callsOnThis[(declaring, method.Name)] = CallsOnThis(declaring, method.Name) + 1;
                            }
                            break;
                        }
                    case OperandType.InlineField:
                        {
                            if ((op == OpCodes.Ldsfld || op == OpCodes.Ldsflda) && field!.DeclaringType is { } fieldType)
                            {
                                // decimal constants 0, 1 and -1 compile to Decimal.Zero / One / MinusOne: a constant step.
                                if (fieldType != typeof(decimal)) current.Ops.Add(DesignerOp.Static(fieldType, field.Name));
                                else
                                {
                                    object known = field.Name switch { "Zero" => 0m, "One" => 1m, "MinusOne" => -1m, _ => Unknown };
                                    current.Ops.Add(DesignerOp.Compiled(known, false));
                                    if (op == OpCodes.Ldsfld) pushed = known;
                                }
                            }
                            if (op == OpCodes.Ldfld && position == 1 && previous == OpCodes.Ldarg_0 && IsDeclaredBy(field!, designed))
                                current.Receiver = field!.Name;
                            if (op == OpCodes.Stfld || op == OpCodes.Stsfld) current.Final = field!.Name;
                            // `this.f = new T(...)`: the newobj is the instruction right before the stfld.
                            if (op == OpCodes.Stfld && previous == OpCodes.Newobj && previousConstructed != null && IsDeclaredBy(field!, designed))
                            {
                                if (!_fieldConstructions.TryGetValue(field!.Name, out var list))
                                    _fieldConstructions[field.Name] = list = new List<Type>();
                                list.Add(previousConstructed);
                            }
                            break;
                        }
                    case OperandType.InlineType:
                        {
                            var type = operandType!;
                            if (op == OpCodes.Newarr)
                            {
                                // The length stays a step: the initializer's count, or the size the source writes.
                                current.Ops.Add(DesignerOp.NewArray(type));
                                var array = new ArrayValue { Element = type };
                                if (poppedValues[0] is long length && length >= 0 && length <= MaxTrackedArray)
                                {
                                    array.Items = new object?[length];
                                    for (int n = 0; n < length; n++) array.Items[n] = DefaultOf(type);
                                }
                                pushed = array;
                            }
                            else if ((op == OpCodes.Castclass || op == OpCodes.Unbox_Any || op == OpCodes.Unbox || op == OpCodes.Isinst)
                                     && !type.IsInterface) current.Ops.Add(DesignerOp.Cast(type));
                            else if (op == OpCodes.Initobj) current.Ops.Add(DesignerOp.New(type));
                            break;
                        }
                    case OperandType.InlineTok:
                        {
                            var member = module.ResolveMember(token, typeArgs, null) ?? throw new InvalidOperationException("unresolved token");
                            // `typeof(T)`: the type is part of what the statement says.
                            if (member is Type tokenType) current.Ops.Add(DesignerOp.Token(tokenType));
                            break;
                        }
                    case OperandType.InlineSig:
                        // calli: an indirect call the designer never writes, whose target cannot be named.
                        throw new InvalidOperationException("indirect call");
                }
                // An element store (`dup; ldc index; <value>; stelem`): the index is the compiler's, not the source's.
                if (IsElementStore(op))
                {
                    if (poppedValues[0] is ArrayValue { Items: { } items } stored)
                    {
                        if (poppedValues[1] is long index && index >= 0 && index < items.Length && poppedValues[2] != Unknown)
                            items[index] = poppedValues[2];
                        else stored.Items = null;
                    }
                    int indexStart = popped[1], valueStart = popped[2];
                    if (indexStart < valueStart) current.Ops.RemoveRange(indexStart, valueStart - indexStart);
                }
                if (IsLocalStore(op)) current.Final = "stloc";

                bool pushedThis = op == OpCodes.Ldarg_0 || (op == OpCodes.Dup && poppedThis.Count == 1 && poppedThis[0]);
                for (int n = Pushes(op, method); n > 0; n--)
                {
                    starts.Add(Math.Min(start, current.Ops.Count));
                    values.Add(pushed);
                    isThis.Add(pushedThis);
                }
                position++;
                previous = op;
                previousConstructed = constructedHere;
                if (starts.Count == 0)
                {
                    _pieces.Add(current);
                    current = null;
                }
            }
            if (current != null || starts.Count != 0) throw new InvalidOperationException("unbalanced stack");
        }

        /// <summary>The type the <paramref name="k"/>th value <paramref name="op"/> pops is taken as, when it tells a
        /// constant's type: an enum parameter, field, local or array element, or any type a box makes of it.</summary>
        private static Type? ConsumerType(OpCode op, int k, MethodBase? method, FieldInfo? field, Type? operandType,
            List<object?> poppedValues, IList<LocalVariableInfo> locals, byte[] il, int operandStart)
        {
            Type? type = null;
            if (op == OpCodes.Box && k == 0) return operandType;
            if (method != null && (op == OpCodes.Call || op == OpCodes.Callvirt || op == OpCodes.Newobj))
            {
                int first = op != OpCodes.Newobj && !method.IsStatic ? 1 : 0;
                var parameters = method.GetParameters();
                if (k >= first && k - first < parameters.Length) type = parameters[k - first].ParameterType;
            }
            else if (field != null && ((op == OpCodes.Stfld && k == 1) || (op == OpCodes.Stsfld && k == 0))) type = field.FieldType;
            else if (IsElementStore(op) && k == 2) type = (poppedValues[0] as ArrayValue)?.Element ?? operandType;
            else if (IsLocalStore(op) && k == 0)
            {
                int index = op == OpCodes.Stloc_0 ? 0 : op == OpCodes.Stloc_1 ? 1 : op == OpCodes.Stloc_2 ? 2 : op == OpCodes.Stloc_3 ? 3
                    : op == OpCodes.Stloc_S ? il[operandStart] : BitConverter.ToUInt16(il, operandStart);
                if (index < locals.Count) type = locals[index].LocalType;
            }
            if (type != null && type.IsByRef) type = type.GetElementType();
            return type != null && type.IsEnum ? type : null;
        }

        private static bool IsNarrowLoad(OpCode op) =>
            op == OpCodes.Ldc_I4 || op == OpCodes.Ldc_I4_S || op == OpCodes.Ldc_I4_M1 || op == OpCodes.Ldc_I4_0
            || op == OpCodes.Ldc_I4_1 || op == OpCodes.Ldc_I4_2 || op == OpCodes.Ldc_I4_3 || op == OpCodes.Ldc_I4_4
            || op == OpCodes.Ldc_I4_5 || op == OpCodes.Ldc_I4_6 || op == OpCodes.Ldc_I4_7 || op == OpCodes.Ldc_I4_8;

        /// <summary>The element an array of <paramref name="element"/> starts with, as constants are read.</summary>
        internal static object? DefaultOf(Type element)
        {
            if (!element.IsValueType) return null;
            if (element == typeof(decimal)) return 0m;
            if (element == typeof(float) || element == typeof(double)) return 0d;
            return element.IsPrimitive || element.IsEnum ? 0L : Unknown;
        }

        /// <summary>The value of a decimal the compiler constructs from constants, or null.</summary>
        internal static decimal? DecimalOf(ConstructorInfo constructor, IReadOnlyList<object?> args)
        {
            var parameters = constructor.GetParameters();
            try
            {
                if (parameters.Length == 1)
                {
                    Type p = parameters[0].ParameterType;
                    object? a = args[0];
                    if (a is long l)
                    {
                        if (p == typeof(int)) return new decimal(unchecked((int)l));
                        if (p == typeof(uint)) return new decimal(unchecked((uint)l));
                        if (p == typeof(long)) return new decimal(l);
                        if (p == typeof(ulong)) return new decimal(unchecked((ulong)l));
                    }
                    if (a is double d)
                    {
                        if (p == typeof(float)) return new decimal((float)d);
                        if (p == typeof(double)) return new decimal(d);
                    }
                    if (p == typeof(int[]) && a is ArrayValue { Items: { } items } && items.All(x => x is long))
                        return new decimal(items.Select(x => unchecked((int)(long)x!)).ToArray());
                    return null;
                }
                if (parameters.Length == 5 && args.All(x => x is long))
                {
                    long lo = (long)args[0]!, mid = (long)args[1]!, hi = (long)args[2]!, negative = (long)args[3]!, scale = (long)args[4]!;
                    if (scale < 0 || scale > 28) return null;
                    return new decimal(unchecked((int)lo), unchecked((int)mid), unchecked((int)hi), negative != 0, (byte)scale);
                }
            }
            catch (ArgumentException) { }
            catch (OverflowException) { }
            return null;
        }

        private static bool IsElementStore(OpCode op) =>
            op == OpCodes.Stelem || op == OpCodes.Stelem_Ref || op == OpCodes.Stelem_I || op == OpCodes.Stelem_I1
            || op == OpCodes.Stelem_I2 || op == OpCodes.Stelem_I4 || op == OpCodes.Stelem_I8 || op == OpCodes.Stelem_R4
            || op == OpCodes.Stelem_R8;

        /// <summary>The value a constant-loading instruction pushes.</summary>
        private static bool ConstantOf(OpCode op, byte[] il, int at, Module module, out object? value)
        {
            value = null;
            if (op == OpCodes.Ldnull) return true;
            if (op == OpCodes.Ldstr)
            {
                value = module.ResolveString(BitConverter.ToInt32(il, at));
                return true;
            }
            if (op == OpCodes.Ldc_I4_M1) { value = -1L; return true; }
            if (op == OpCodes.Ldc_I4_0) { value = 0L; return true; }
            if (op == OpCodes.Ldc_I4_1) { value = 1L; return true; }
            if (op == OpCodes.Ldc_I4_2) { value = 2L; return true; }
            if (op == OpCodes.Ldc_I4_3) { value = 3L; return true; }
            if (op == OpCodes.Ldc_I4_4) { value = 4L; return true; }
            if (op == OpCodes.Ldc_I4_5) { value = 5L; return true; }
            if (op == OpCodes.Ldc_I4_6) { value = 6L; return true; }
            if (op == OpCodes.Ldc_I4_7) { value = 7L; return true; }
            if (op == OpCodes.Ldc_I4_8) { value = 8L; return true; }
            if (op == OpCodes.Ldc_I4_S) { value = (long)(sbyte)il[at]; return true; }
            if (op == OpCodes.Ldc_I4) { value = (long)BitConverter.ToInt32(il, at); return true; }
            if (op == OpCodes.Ldc_I8) { value = BitConverter.ToInt64(il, at); return true; }
            if (op == OpCodes.Ldc_R4) { value = (double)BitConverter.ToSingle(il, at); return true; }
            if (op == OpCodes.Ldc_R8) { value = BitConverter.ToDouble(il, at); return true; }
            return false;
        }

        /// <summary>The (receiver field, final member) a source statement targets, as its compiled piece shows them:
        /// <c>button1.BackColor = …</c> → (button1, BackColor); <c>Controls.Add(…)</c> → ("", Add);
        /// <c>this.button1 = new …</c> → ("", button1); <c>button1.Click += …</c> → (button1, Click).</summary>
        internal static (string Receiver, string Final)? TargetOf(StatementSyntax statement, ISet<string> fields)
        {
            if (statement is LocalDeclarationStatementSyntax) return ("", "stloc");
            if (statement is not ExpressionStatementSyntax { Expression: var expression }) return null;
            List<string>? chain;
            string final;
            switch (expression)
            {
                case AssignmentExpressionSyntax assignment:
                    chain = Chain(assignment.Left);
                    if (chain == null || chain.Count == 0) return null;
                    final = chain[chain.Count - 1];
                    chain.RemoveAt(chain.Count - 1);
                    break;
                case InvocationExpressionSyntax { Expression: MemberAccessExpressionSyntax access }:
                    chain = Chain(access.Expression);
                    if (chain == null) return null;
                    final = access.Name.Identifier.ValueText;
                    break;
                case InvocationExpressionSyntax { Expression: IdentifierNameSyntax bare }:
                    chain = new List<string>();
                    final = bare.Identifier.ValueText;
                    break;
                default:
                    return null;
            }
            string receiver = chain.Count > 0 && fields.Contains(chain[0]) ? chain[0] : "";
            return (receiver, final);
        }

        /// <summary>The identifier path of a receiver, with `this.`, parentheses and casts removed; null for anything
        /// else.</summary>
        private static List<string>? Chain(ExpressionSyntax expression)
        {
            var names = new List<string>();
            bool ok = true;
            void Walk(ExpressionSyntax e)
            {
                switch (e)
                {
                    case MemberAccessExpressionSyntax m: Walk(m.Expression); names.Add(m.Name.Identifier.ValueText); break;
                    case IdentifierNameSyntax id: names.Add(id.Identifier.ValueText); break;
                    case ThisExpressionSyntax: break;
                    case ParenthesizedExpressionSyntax p: Walk(p.Expression); break;
                    case CastExpressionSyntax c: Walk(c.Expression); break;
                    default: ok = false; break;
                }
            }
            Walk(expression);
            return ok ? names : null;
        }

        private static string MemberKey(string name)
        {
            foreach (string prefix in new[] { "set_", "get_", "add_", "remove_" })
                if (name.StartsWith(prefix, StringComparison.Ordinal)) return name.Substring(prefix.Length);
            return name;
        }

        private static bool IsLocalStore(OpCode op) =>
            op == OpCodes.Stloc || op == OpCodes.Stloc_S || op == OpCodes.Stloc_0 || op == OpCodes.Stloc_1
            || op == OpCodes.Stloc_2 || op == OpCodes.Stloc_3;

        private static int Pops(OpCode op, MethodBase? method)
        {
            switch (op.StackBehaviourPop)
            {
                case StackBehaviour.Pop0: return 0;
                case StackBehaviour.Pop1: case StackBehaviour.Popi: case StackBehaviour.Popref: return 1;
                case StackBehaviour.Pop1_pop1: case StackBehaviour.Popi_pop1: case StackBehaviour.Popi_popi:
                case StackBehaviour.Popi_popi8: case StackBehaviour.Popi_popr4: case StackBehaviour.Popi_popr8:
                case StackBehaviour.Popref_pop1: case StackBehaviour.Popref_popi: return 2;
                case StackBehaviour.Popi_popi_popi: case StackBehaviour.Popref_popi_popi: case StackBehaviour.Popref_popi_popi8:
                case StackBehaviour.Popref_popi_popr4: case StackBehaviour.Popref_popi_popr8: case StackBehaviour.Popref_popi_popref:
                case StackBehaviour.Popref_popi_pop1: return 3;
                case StackBehaviour.Varpop:
                    if (method == null) throw new InvalidOperationException("variable pop without a method");
                    int count = method.GetParameters().Length;
                    if (op != OpCodes.Newobj && !method.IsStatic) count++;
                    return count;
                default: throw new InvalidOperationException("unknown stack behaviour");
            }
        }

        private static int Pushes(OpCode op, MethodBase? method)
        {
            switch (op.StackBehaviourPush)
            {
                case StackBehaviour.Push0: return 0;
                case StackBehaviour.Push1: case StackBehaviour.Pushi: case StackBehaviour.Pushi8: case StackBehaviour.Pushr4:
                case StackBehaviour.Pushr8: case StackBehaviour.Pushref: return 1;
                case StackBehaviour.Push1_push1: return 2;
                case StackBehaviour.Varpush:
                    // `call instance void Point::.ctor(…)` initializes a struct in place and pushes nothing.
                    if (method is ConstructorInfo) return 0;
                    if (method is not MethodInfo info) throw new InvalidOperationException("variable push without a method");
                    return info.ReturnType == typeof(void) ? 0 : 1;
                default: throw new InvalidOperationException("unknown stack behaviour");
            }
        }

        private static bool IsDeclaredBy(FieldInfo field, Type designed)
        {
            var declaring = field.DeclaringType;
            if (declaring == null) return false;
            if (declaring == designed) return true;
            return declaring.IsGenericType && designed.IsGenericType
                && declaring.GetGenericTypeDefinition() == designed.GetGenericTypeDefinition();
        }

        private static int SwitchOperandSize(byte[] il, int at)
        {
            if (at + 4 > il.Length) throw new InvalidOperationException("truncated switch");
            int count = BitConverter.ToInt32(il, at);
            if (count < 0 || count > MaxSwitchTargets) throw new InvalidOperationException("switch too large");
            return 4 + 4 * count;
        }
    }
}
