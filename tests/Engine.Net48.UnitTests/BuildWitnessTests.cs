using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Windows.Forms;
using Xunit;
using WinFormsDesigner.Engine;

namespace Engine.Net48.UnitTests
{
    public enum WitnessKind { None, Combo, Ellipsis }

    /// <summary>A vendor-style value: a class no allowlist names, constructed with an enum by the designer code.</summary>
    public sealed class WitnessButton
    {
        public static int Constructions;
        public WitnessButton(WitnessKind kind) { Kind = kind; Constructions++; }
        public WitnessKind Kind { get; }
    }

    /// <summary>A value the build constructs, but outside InitializeComponent: never a witness.</summary>
    public sealed class WitnessCanary
    {
        public static int Constructions;
        public WitnessCanary(string text) { Text = text; Constructions++; }
        public string Text { get; }
    }

    public sealed class WitnessButtonHost : Control
    {
        public List<WitnessButton> Buttons { get; } = new List<WitnessButton>();
    }

    /// <summary>The compiled form whose InitializeComponent is the witness.</summary>
    public sealed class WitnessForm : UserControl
    {
        private WitnessButtonHost host1 = null!;
        public WitnessForm() { InitializeComponent(); }

        private void InitializeComponent()
        {
            this.host1 = new WitnessButtonHost();
            this.host1.Buttons.AddRange(new WitnessButton[] { new WitnessButton(WitnessKind.Combo) });
            this.Controls.Add(this.host1);
        }

        public object Other() => new WitnessCanary("elsewhere");
    }

    /// <summary>A compiled form whose argument depends on a branch: the IL loads a constant on each arm and joins at
    /// the construction, so neither constant is provably what it passes.</summary>
    public sealed class WitnessConditionalForm : UserControl
    {
        public static bool Flag => Environment.TickCount == int.MinValue;
        private WitnessButtonHost host1 = null!;
        public WitnessConditionalForm() { InitializeComponent(); }

        private void InitializeComponent()
        {
            this.host1 = new WitnessButtonHost();
            this.host1.Buttons.AddRange(new WitnessButton[] { new WitnessButton(Flag ? WitnessKind.Ellipsis : WitnessKind.Combo) });
            this.Controls.Add(this.host1);
        }
    }

    /// <summary>The linked IL witness over hand-written IL, with constructor tokens 1–3 standing for
    /// <see cref="BuildWitnessTests.IntValue"/>, <see cref="BuildWitnessTests.RealValue"/> and
    /// <see cref="BuildWitnessTests.U64Value"/>.</summary>
    internal sealed class WitnessUnderTest
    {
        private readonly WinFormsDesigner.Engine.Net48.BuildConstructionWitness _witness;

        public WitnessUnderTest(byte[] il, params (int TryOffset, int TryLength, int HandlerOffset)[] clauses)
        {
            _witness = WinFormsDesigner.Engine.Net48.BuildConstructionWitness.FromIl(il, token => token switch
            {
                1 => typeof(BuildWitnessTests.IntValue).GetConstructors().Single(),
                2 => typeof(BuildWitnessTests.RealValue).GetConstructors().Single(),
                3 => typeof(BuildWitnessTests.U64Value).GetConstructors().Single(),
                4 => typeof(BuildWitnessTests.NullValue).GetConstructor(new[] { typeof(object) }),
                5 => typeof(BuildWitnessTests.SoloNull).GetConstructors().Single(),
                6 => typeof(BuildWitnessTests.OptionalNullValue).GetConstructor(new[] { typeof(object) }),
                _ => null,
            }, _ => null, clauses.Select(c => new WinFormsDesigner.Engine.Net48.BuildConstructionWitness.HandlerClause
            {
                TryOffset = c.TryOffset, TryLength = c.TryLength, HandlerOffset = c.HandlerOffset, FilterOffset = -1,
            }));
        }

        public bool Can(Type type, object? arg) => _witness.CanConstruct(type, new[] { arg }, out _);
    }

    // A value of a type no allowlist names is constructed only where the project's build makes exactly that
    // construction in the designed type's InitializeComponent; everywhere else it stays what it was: a gap.
    public sealed class BuildWitnessTests
    {
        private static string Source(string buttons, string extra = "") => @"
namespace Engine.Net48.UnitTests {
  partial class WitnessForm : System.Windows.Forms.UserControl {
    private Engine.Net48.UnitTests.WitnessButtonHost host1;
    private void InitializeComponent() {
      this.host1 = new Engine.Net48.UnitTests.WitnessButtonHost();
      this.host1.Buttons.AddRange(new Engine.Net48.UnitTests.WitnessButton[] { " + buttons + @" });
      " + extra + @"
      this.Controls.Add(this.host1);
    }
  }
}";

        private const string Combo = "new Engine.Net48.UnitTests.WitnessButton(Engine.Net48.UnitTests.WitnessKind.Combo)";

        private sealed class Host : IIrHost
        {
            private static readonly Assembly[] Probe =
            {
                typeof(BuildWitnessTests).Assembly, typeof(Control).Assembly, typeof(Color).Assembly,
                typeof(Point).Assembly, typeof(ISupportInitialize).Assembly, typeof(object).Assembly,
            };
            public Type? ResolveType(string typeName)
            {
                foreach (var a in Probe) { var t = a.GetType(typeName, false); if (t != null) return t; }
                return null;
            }
            public object CreateComponent(Type type, string name, bool withContainer) => Activator.CreateInstance(type)!;
            public object? ResolveResource(string key, bool isString) => null;
            public bool WasResourceRefused(string key) => false;
            public bool HasResource(string key) => false;
            public bool HasResourceSet => false;
            public bool ApplyResources(object target, string key, out string? error) { error = "none"; return false; }
        }

        /// <summary>A witness that admits everything it is asked about and records what it was asked.</summary>
        private sealed class AdmittingHost : IIrHost, IIrConstructionWitness
        {
            private readonly Host _inner = new Host();
            public readonly List<Type> Asked = new List<Type>();
            public Type? ResolveType(string typeName) => _inner.ResolveType(typeName);
            public object CreateComponent(Type type, string name, bool withContainer) => _inner.CreateComponent(type, name, withContainer);
            public object? ResolveResource(string key, bool isString) => null;
            public bool WasResourceRefused(string key) => false;
            public bool HasResource(string key) => false;
            public bool HasResourceSet => false;
            public bool ApplyResources(object target, string key, out string? error) { error = "none"; return false; }
            public bool CanConstruct(Type type, object?[] args, out string reason)
            {
                Asked.Add(type);
                bool admitted = Admits == null || Admits(args);
                reason = admitted ? "" : "not made by the build";
                return admitted;
            }
            public bool TryConstruct(Type type, object?[] args, out object? value, out string reason)
            {
                value = null;
                if (!CanConstruct(type, args, out reason)) return false;
                value = Activator.CreateInstance(type, args);
                return true;
            }
            public Func<object?[], bool>? Admits;
        }

        [Fact]
        public void Builder_KeepsTheGap_AndCarriesAWitnessCandidate()
        {
            var doc = DesignerIrBuilder.Build(Source(Combo))!;
            Assert.False(doc.FullCoverage); // every consumer without a witness sees exactly the old gap
            var candidate = Assert.Single(doc.WitnessCandidates);
            Assert.Contains(candidate.Reason, doc.UnrepresentableReasons);
            var add = Assert.IsType<IrAddCollectionItem>(Assert.Single(candidate.Statements));
            var ctor = Assert.IsType<IrBuildWitnessedCtor>(add.Item);
            Assert.Equal(typeof(WitnessButton).FullName, ctor.TypeName);
            Assert.IsType<IrEnum>(Assert.Single(ctor.Args));
            Assert.Null(IrValidate.Check(doc));

            var merged = doc.WithWitnessCandidates();
            Assert.True(merged.FullCoverage);
            Assert.Empty(merged.WitnessCandidates);
            Assert.DoesNotContain(candidate.Reason, merged.UnrepresentableReasons);
            Assert.IsType<IrAddCollectionItem>(merged.Statements[1]); // at its source position, after host1's construction
            Assert.Null(IrValidate.Check(merged));
        }

        [Fact]
        public void Builder_OnlyConstantArgumentsMakeACandidate()
        {
            Assert.Empty(DesignerIrBuilder.Build(Source("new Engine.Net48.UnitTests.WitnessButton((Engine.Net48.UnitTests.WitnessKind)1)"))!.WitnessCandidates);
            Assert.Empty(DesignerIrBuilder.Build(Source("new Engine.Net48.UnitTests.WitnessButton(Make())"))!.WitnessCandidates);
            Assert.Empty(DesignerIrBuilder.Build(Source(
                "new Engine.Net48.UnitTests.WitnessButton(new Engine.Net48.UnitTests.WitnessButton(Engine.Net48.UnitTests.WitnessKind.Combo))"))!.WitnessCandidates);
        }

        [Fact]
        public void Validator_RefusesAForgedNonConstantArgument_AndCandidatesOutOfOrder()
        {
            var doc = DesignerIrBuilder.Build(Source(Combo))!;
            var ctor = (IrBuildWitnessedCtor)((IrAddCollectionItem)doc.WitnessCandidates[0].Statements[0]).Item;
            ctor.Args[0] = new IrComponentRef { Name = "host1" };
            Assert.Equal("witnessed ctor argument is not a constant", IrValidate.Check(doc));

            var other = DesignerIrBuilder.Build(Source(Combo))!;
            other.WitnessCandidates[0].Position = other.Statements.Count + 1;
            Assert.NotNull(IrValidate.Check(other));
            Assert.Same(other, other.WithWitnessCandidates()); // out of range: nothing is merged
        }

        [Fact]
        public void Executor_WithoutAWitness_RefusesAsTheOldGap()
        {
            var merged = DesignerIrBuilder.Build(Source(Combo))!.WithWitnessCandidates();
            int before = WitnessButton.Constructions;

            var strict = DesignerIrExecutor.Execute(merged, new UserControl(), new Host());
            Assert.False(strict.Ok);
            Assert.StartsWith(DesignerIrExecutor.UnwitnessedPrefix, strict.FailureReason);
            Assert.Equal(RenderFallbackReason.UnrepresentableStatements, RenderModeClassifier.FromExecution(strict).FallbackReason);
            // A document merged without authorization is refused in a partial replay too, never half-applied.
            Assert.False(DesignerIrExecutor.Execute(merged, new UserControl(), new Host(), partial: true).Ok);
            Assert.Equal(before, WitnessButton.Constructions); // nothing of the type ran
        }

        [Fact]
        public void Authorization_TakesAWholeStatementOrNone_BeforeAnythingRuns()
        {
            // One AddRange with two values; the build makes only the first. The whole statement stays the gap it
            // was: nothing is merged, no constructor or receiver getter runs, and no first element is left behind.
            var doc = DesignerIrBuilder.Build(Source(Combo + ", new Engine.Net48.UnitTests.WitnessButton(Engine.Net48.UnitTests.WitnessKind.Ellipsis)"))!;
            var candidate = Assert.Single(doc.WitnessCandidates);
            Assert.Equal(2, candidate.Statements.Count);
            var host = new AdmittingHost { Admits = args => Equals(args[0], WitnessKind.Combo) };
            int before = WitnessButton.Constructions;

            Assert.False(Authorize(candidate, host, out var reason));
            Assert.Same(doc, doc.WithWitnessCandidates(c => Authorize(c, host, out _)));
            Assert.Equal(before, WitnessButton.Constructions);
            Assert.NotEqual("", reason);

            // Both values made by the build: the statement is admitted whole.
            host.Admits = null;
            Assert.True(Authorize(candidate, host, out _));
            Assert.Equal(before, WitnessButton.Constructions); // authorization constructs nothing
            Assert.False(Authorize(candidate, new Host(), out _)); // no witness, no admission
        }

        [Fact]
        public void Validator_RefusesCandidatesInDescendingOrder()
        {
            var doc = DesignerIrBuilder.Build(Source(Combo, "this.host1.Tag = new Engine.Net48.UnitTests.WitnessCanary(\"x\");"))!;
            Assert.Equal(2, doc.WitnessCandidates.Count);
            doc.WitnessCandidates.Reverse();
            if (doc.WitnessCandidates[0].Position == doc.WitnessCandidates[1].Position) doc.WitnessCandidates[0].Position++;
            Assert.Equal("witness candidate out of order", IrValidate.Check(doc));
            Assert.Same(doc, doc.WithWitnessCandidates());
        }

        // ------------------------------------------------------------------ the IL witness itself ---------------

        public sealed class IntValue { public IntValue(int value) { } }
        public sealed class RealValue { public RealValue(double value) { } }
        public sealed class U64Value { public U64Value(ulong value) { } }
        public sealed class NullValue { public NullValue(object value) { } public NullValue(string value) { } }
        public sealed class SoloNull { public SoloNull(string value) { } }

        [Fact]
        public void IlWitness_ANullArgumentCountsOnlyWhereOneConstructorCanTakeIt()
        {
            // ldnull; newobj NullValue(object): C# binds `new NullValue(null)` to the string overload, so the build's
            // object construction proves nothing about it.
            Assert.False(Witness(0x14, 0x73, 4, 0, 0, 0, 0x26, 0x2A).Can(typeof(NullValue), null));
            // ldnull; newobj SoloNull(string): the only constructor of that arity.
            Assert.True(Witness(0x14, 0x73, 5, 0, 0, 0, 0x26, 0x2A).Can(typeof(SoloNull), null));
        }

        [Fact]
        public void IlWitness_IgnoresConstructionsNoPathReaches()
        {
            // br.s LIVE; ldc.i4 999; newobj IntValue; pop; LIVE: ldc.i4 42; newobj IntValue; pop; ret
            var w = Witness(0x2B, 0x0B, 0x20, 0xE7, 0x03, 0x00, 0x00, 0x73, IntCtorToken, 0, 0, 0, 0x26,
                0x20, 0x2A, 0x00, 0x00, 0x00, 0x73, IntCtorToken, 0, 0, 0, 0x26, 0x2A);
            Assert.False(w.Can(typeof(IntValue), 999));
            Assert.True(w.Can(typeof(IntValue), 42));
        }

        [Fact]
        public void Witnessed_ValuesAreTakenOnlyWhereTheyReachTheirUseUnconverted()
        {
            // Under a cast or inside another construction a conversion the replay does not reproduce would apply.
            Assert.Empty(DesignerIrBuilder.Build(Source(Combo, "this.host1.Tag = (object)" + Combo + ";"))!
                .WitnessCandidates.Where(c => c.Statements.OfType<IrSetProperty>().Any()));
            var forged = DesignerIrBuilder.Build(Source(Combo))!;
            var add = (IrAddCollectionItem)forged.WitnessCandidates[0].Statements[0];
            add.Item = new IrCast { TargetTypeName = "System.Object", Inner = add.Item };
            Assert.Equal("witnessed construction in an unsupported position", IrValidate.Check(forged));

            // An element only into an array that holds it as it is.
            var mistyped = DesignerIrBuilder.Build(Source(Combo, "this.host1.Tag = new System.Windows.Forms.Padding[] { " + Combo + " };"))!;
            var candidate = Assert.Single(mistyped.WitnessCandidates, c => c.Statements.OfType<IrSetProperty>().Any());
            var host = new AdmittingHost();
            Assert.False(Authorize(candidate, host, out var reason));
            Assert.Contains("without a conversion", reason);
            Assert.Empty(host.Asked); // refused before the witness is asked
        }

        private static bool Authorize(IrWitnessCandidate candidate, IIrHost host, out string reason) =>
            DesignerIrExecutor.AuthorizeWitnessCandidate(candidate, host, Array.Empty<string>(), null, out reason);

        [Fact]
        public void Authorization_RefusesNamesCSharpMayBindOtherwise()
        {
            var doc = DesignerIrBuilder.Build(Source(Combo))!;
            var candidate = Assert.Single(doc.WitnessCandidates);
            var host = new AdmittingHost();

            // A context namespace that turns the dotted name into another type: C# binds it relative to that namespace.
            Assert.False(DesignerIrExecutor.AuthorizeWitnessCandidate(candidate, host,
                new[] { "Engine.Net48.UnitTests.Shadow" }, null, out var reason));
            Assert.Contains("may name", reason);

            // The form has a member named like the first part of the enum's name: C# reads the member, not the enum.
            var shadowed = DesignerIrBuilder.Build(Source("new Engine.Net48.UnitTests.WitnessButton(Shadowing.WitnessKind.Combo)"))!;
            Assert.False(DesignerIrExecutor.AuthorizeWitnessCandidate(Assert.Single(shadowed.WitnessCandidates), host,
                Array.Empty<string>(), typeof(WitnessShadowingForm), out reason));
            Assert.Contains("is a member of", reason);

            Assert.True(DesignerIrExecutor.AuthorizeWitnessCandidate(candidate, host, Array.Empty<string>(), typeof(WitnessForm), out reason), reason);

            // A type of a file namespace named like the first part of the name takes that part in C#.
            Assert.False(DesignerIrExecutor.AuthorizeWitnessCandidate(candidate, host,
                new[] { "Engine.Net48.UnitTests.PrefixShadow" }, null, out reason));
            Assert.Contains("may start with the type", reason);
        }

        [Fact]
        public void Builder_AFileWithAliasesOrStaticImportsGetsNoCandidates()
        {
            Assert.NotEmpty(DesignerIrBuilder.Build(Source(Combo))!.WitnessCandidates);
            Assert.Empty(DesignerIrBuilder.Build("using AliasVendor = Engine.Net48.UnitTests;\r\n" + Source(Combo))!.WitnessCandidates);
            Assert.Empty(DesignerIrBuilder.Build("using static Engine.Net48.UnitTests.WitnessKind;\r\n" + Source(Combo))!.WitnessCandidates);
        }

        public class WitnessOuter
        {
            public static object Engine = new object();
            public sealed class NestedForm : UserControl { }
        }

        public class WitnessBaseWithNested : UserControl
        {
            protected sealed class Engine { }
        }

        public sealed class WitnessDerivedForm : WitnessBaseWithNested { }

        [Fact]
        public void Authorization_SeesMembersOfEnclosingTypesAndTypesNestedInBases()
        {
            var candidate = Assert.Single(DesignerIrBuilder.Build(Source(Combo))!.WitnessCandidates);
            var host = new AdmittingHost();
            // The type name starts with `Engine`, which the enclosing type and the base form declare.
            Assert.False(DesignerIrExecutor.AuthorizeWitnessCandidate(candidate, host, Array.Empty<string>(),
                typeof(WitnessOuter.NestedForm), out var reason));
            Assert.Contains("is a member of", reason);
            Assert.False(DesignerIrExecutor.AuthorizeWitnessCandidate(candidate, host, Array.Empty<string>(),
                typeof(WitnessDerivedForm), out reason));
            Assert.Contains("is a type nested in", reason);
        }

        [Fact]
        public void IlWitness_RefusesATypeWhoseConstructorsCarryCustomModifiers()
        {
            // Two constructors whose parameter types read the same, told apart by a modopt — as a vendor DLL may declare.
            var assembly = System.Reflection.Emit.AssemblyBuilder.DefineDynamicAssembly(
                new AssemblyName("WitnessModifierProbe"), System.Reflection.Emit.AssemblyBuilderAccess.Run);
            var type = assembly.DefineDynamicModule("WitnessModifierProbe").DefineType("ModValue", TypeAttributes.Public);
            foreach (var modifiers in new[] { null, new[] { new[] { typeof(System.Runtime.CompilerServices.IsConst) } } })
            {
                var ctor = type.DefineConstructor(MethodAttributes.Public, CallingConventions.Standard, new[] { typeof(int) },
                    null, modifiers);
                var il = ctor.GetILGenerator();
                il.Emit(System.Reflection.Emit.OpCodes.Ldarg_0);
                il.Emit(System.Reflection.Emit.OpCodes.Call, typeof(object).GetConstructor(Type.EmptyTypes)!);
                il.Emit(System.Reflection.Emit.OpCodes.Ret);
            }
            var created = type.CreateType()!;
            var plain = created.GetConstructors().First(c => c.GetParameters()[0].GetOptionalCustomModifiers().Length == 0);
            var witness = WinFormsDesigner.Engine.Net48.BuildConstructionWitness.FromIl(
                new byte[] { 0x1D, 0x73, 8, 0, 0, 0, 0x26, 0x2A }, token => token == 8 ? plain : null, _ => null,
                Array.Empty<WinFormsDesigner.Engine.Net48.BuildConstructionWitness.HandlerClause>());
            Assert.False(witness.CanConstruct(created, new object?[] { 7 }, out var reason));
            Assert.Contains("custom modifiers", reason);
        }

        public sealed class PriorityValue
        {
            public PriorityValue(int exact) { }
            [System.Runtime.CompilerServices.OverloadResolutionPriority(1)]
            public PriorityValue(long promoted) { }
        }

        [Fact]
        public void IlWitness_RefusesATypeWhoseConstructorsCarryResolutionPriorities()
        {
            var priority = WinFormsDesigner.Engine.Net48.BuildConstructionWitness.FromIl(
                new byte[] { 0x1D, 0x73, 7, 0, 0, 0, 0x26, 0x2A },
                token => token == 7 ? typeof(PriorityValue).GetConstructor(new[] { typeof(int) }) : null, _ => null,
                Array.Empty<WinFormsDesigner.Engine.Net48.BuildConstructionWitness.HandlerClause>());
            Assert.False(priority.CanConstruct(typeof(PriorityValue), new object?[] { 7 }, out var reason));
            Assert.Contains("priorities", reason);
        }

        private const int IntCtorToken = 1, RealCtorToken = 2, U64CtorToken = 3;

        private static Engine.Net48.UnitTests.WitnessUnderTest Witness(params byte[] il) => new Engine.Net48.UnitTests.WitnessUnderTest(il);

        [Fact]
        public void IlWitness_RefusesARunThatAnotherBranchEnters()
        {
            // ldc.i4.2; br.s JOIN; ldc.i4.1; JOIN: newobj IntValue(int); pop; ret — the build passes 2, never 1.
            var w = Witness(0x18, 0x2B, 0x01, 0x17, 0x73, IntCtorToken, 0, 0, 0, 0x26, 0x2A);
            Assert.False(w.Can(typeof(IntValue), 1));
            Assert.False(w.Can(typeof(IntValue), 2));
            // The same constant without a join is witnessed.
            Assert.True(Witness(0x17, 0x73, IntCtorToken, 0, 0, 0, 0x26, 0x2A).Can(typeof(IntValue), 1));
        }

        [Fact]
        public void IlWitness_RefusesARunAnExceptionHandlerEnters()
        {
            var w = new Engine.Net48.UnitTests.WitnessUnderTest(new byte[] { 0x17, 0x73, IntCtorToken, 0, 0, 0, 0x26, 0x2A }, (0, 1, 1));
            Assert.False(w.Can(typeof(IntValue), 1));
        }

        [Fact]
        public void IlWitness_AProtectedBlockNoPathReachesStaysUnreachable()
        {
            // br.s LIVE; .try { ldc.i4 999; newobj IntValue; pop; leave.s LIVE } catch { pop; leave.s LIVE }
            // LIVE: ldc.i4 42; newobj IntValue; pop; ret
            var w = new Engine.Net48.UnitTests.WitnessUnderTest(new byte[]
            {
                0x2B, 0x10,
                0x20, 0xE7, 0x03, 0x00, 0x00, 0x73, IntCtorToken, 0, 0, 0, 0x26, 0xDE, 0x03,
                0x26, 0xDE, 0x00,
                0x20, 0x2A, 0x00, 0x00, 0x00, 0x73, IntCtorToken, 0, 0, 0, 0x26, 0x2A,
            }, (2, 13, 15));
            Assert.False(w.Can(typeof(IntValue), 999));
            Assert.True(w.Can(typeof(IntValue), 42));
        }

        public sealed class OptionalNullValue
        {
            public OptionalNullValue(object value) { }
            public OptionalNullValue(string value, int ignored = 0) { }
        }

        [Fact]
        public void IlWitness_ANullArgumentCountsOnlyForATypeWithOneConstructor()
        {
            // C# binds `new OptionalNullValue(null)` to (string, int = 0), never to the build's (object) site; the
            // same holds for a params array or a params collection, so any second constructor refuses null.
            Assert.False(Witness(0x14, 0x73, 6, 0, 0, 0, 0x26, 0x2A).Can(typeof(OptionalNullValue), null));
        }

        [Fact]
        public void IlWitness_NothingAfterAJmpIsReached()
        {
            // jmp <method>; ldc.i4 999; newobj IntValue; pop; ret — jmp leaves the method, so 999 is never passed.
            var w = Witness(0x27, 0, 0, 0, 0, 0x20, 0xE7, 0x03, 0x00, 0x00, 0x73, IntCtorToken, 0, 0, 0, 0x26, 0x2A);
            Assert.False(w.Can(typeof(IntValue), 999));
        }

        [Fact]
        public void Builder_TakesOnlyArgumentsTheReplayReproducesExactly()
        {
            string Make(string arg) => Source("new Engine.Net48.UnitTests.WitnessButton(Engine.Net48.UnitTests.WitnessKind.Combo)",
                "this.host1.Tag = new Engine.Net48.UnitTests.BuildWitnessTests.RealValue(" + arg + ");");
            bool Candidate(string arg) => DesignerIrBuilder.Build(Make(arg))!.WitnessCandidates
                .Any(c => c.Statements.OfType<IrSetProperty>().Any());
            // Floating literals are not taken at all: the .NET Framework reads some differently from the compiler.
            Assert.False(Candidate("1.5"));
            Assert.False(Candidate("-0.0"));
            Assert.False(Candidate("9.66496831707127E-148D"));
            Assert.False(Candidate("1.5M"));
            Assert.False(IrValidate.IsExactWitnessConstant(new IrNumber { Kind = IrNumericKind.UInt32, InvariantText = "-0" }));
            Assert.True(IrValidate.IsExactWitnessConstant(new IrNumber { Kind = IrNumericKind.UInt32, InvariantText = "7" }));
            Assert.True(IrValidate.IsExactWitnessConstant(new IrNumber { Kind = IrNumericKind.Int32, InvariantText = "-7" }));
        }

        [Fact]
        public void Builder_AnAddRangeElementOfAnotherTypeThanItsArrayStaysAGap()
        {
            var doc = DesignerIrBuilder.Build(Source(Combo).Replace(
                "new Engine.Net48.UnitTests.WitnessButton[] {", "new object[] {"))!;
            Assert.Empty(doc.WitnessCandidates);
        }

        [Fact]
        public void IlWitness_ConvR8_IsExactAndConvU8_KeepsAllSixtyFourBits()
        {
            // ldc.i8 16777217; conv.r8; newobj RealValue(double)
            var real = Witness(0x21, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x6C, 0x73, RealCtorToken, 0, 0, 0, 0x26, 0x2A);
            Assert.True(real.Can(typeof(RealValue), 16777217d));
            Assert.False(real.Can(typeof(RealValue), 16777216d));
            // ldc.i8 4294967297; conv.u8; newobj U64Value(ulong)
            var wide = Witness(0x21, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x6E, 0x73, U64CtorToken, 0, 0, 0, 0x26, 0x2A);
            Assert.True(wide.Can(typeof(U64Value), 4294967297UL));
            Assert.False(wide.Can(typeof(U64Value), 1UL));
            // ldc.i4.m1; conv.u8 zero-extends the int32: 4294967295, not ulong.MaxValue.
            var narrow = Witness(0x15, 0x6E, 0x73, U64CtorToken, 0, 0, 0, 0x26, 0x2A);
            Assert.True(narrow.Can(typeof(U64Value), 4294967295UL));
            Assert.False(narrow.Can(typeof(U64Value), ulong.MaxValue));
        }

        [Fact]
        public void Executor_RefusesFrameworkAndComponentTypes_BeforeAskingAnyWitness()
        {
            var host = new AdmittingHost();
            foreach (var type in new[] { "System.Text.StringBuilder", "System.Windows.Forms.Button" })
            {
                var doc = DesignerIrBuilder.Build(Source(Combo))!.WithWitnessCandidates();
                var add = (IrAddCollectionItem)doc.Statements[1];
                add.Item = new IrBuildWitnessedCtor { TypeName = type, Args = { new IrString { Value = "x" } } };
                var result = DesignerIrExecutor.Execute(doc, new UserControl(), host);
                Assert.False(result.Ok);
                Assert.Contains("construction not allowed: " + type, result.FailureReason);
            }
            Assert.Empty(host.Asked);

            var admitted = DesignerIrExecutor.Execute(DesignerIrBuilder.Build(Source(Combo))!.WithWitnessCandidates(), new UserControl(), host);
            Assert.True(admitted.Ok, admitted.FailureReason);
            Assert.Equal(WitnessKind.Combo, Assert.Single(((WitnessButtonHost)admitted.Instances["host1"]).Buttons).Kind);
        }

        [Fact]
        public void Worker_ConstructsOnlyWhatTheBuildConstructs()
        {
            string designerPath = Path.Combine(Path.GetTempPath(), "WitnessForm." + Guid.NewGuid().ToString("N") + ".Designer.cs");
            Assembly engine = Net48EngineAssembly();
            object worker = Activator.CreateInstance(engine.GetType("WinFormsDesigner.Engine.Net48.RenderWorker", throwOnError: true)!)!;
            string assemblyPath = typeof(WitnessForm).Assembly.Location;
            string rootType = typeof(WitnessForm).FullName!;
            MethodInfo build = engine.GetType("WinFormsDesigner.Engine.DesignerIrBuilder", throwOnError: true)!
                .GetMethod("Build", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic)!;
            MethodInfo render = worker.GetType().GetMethod("RenderInterpretedWithLayout")!;
            object Render(string source)
            {
                File.WriteAllText(designerPath, source);
                object document = build.Invoke(null, new object?[] { source })!;
                return render.Invoke(worker, new object?[]
                {
                    designerPath, assemblyPath, document, rootType, 0, 0, null, 1, "", typeof(UserControl).FullName!,
                })!;
            }
            try
            {
                // The build makes this construction: the form is interpreted completely, the vendor value included.
                object same = Render(Source(Combo));
                Assert.Equal("interpreted", (string)Get(same, "RenderMode"));

                // An argument the build never passes: not witnessed, so the statement is the gap it was and the form
                // falls back to its build for that reason.
                object edited = Render(Source("new Engine.Net48.UnitTests.WitnessButton(Engine.Net48.UnitTests.WitnessKind.Ellipsis)"));
                Assert.Equal("compiledFallback", (string)Get(edited, "RenderMode"));
                Assert.Equal("unrepresentableStatements", (string)Get(edited, "FallbackReason"));

                // A construction the build makes only outside InitializeComponent is never run by the replay.
                int canaries = WitnessCanary.Constructions;
                object elsewhere = Render(Source(Combo, "this.host1.Tag = new Engine.Net48.UnitTests.WitnessCanary(\"elsewhere\");"));
                Assert.Equal("compiledFallback", (string)Get(elsewhere, "RenderMode"));
                Assert.Equal(canaries, WitnessCanary.Constructions);

                // An argument chosen by a branch in the build witnesses neither constant.
                string conditional = Source(Combo).Replace("partial class WitnessForm", "partial class WitnessConditionalForm");
                File.WriteAllText(designerPath, conditional);
                object conditionalDocument = build.Invoke(null, new object?[] { conditional })!;
                object branched = render.Invoke(worker, new object?[]
                {
                    designerPath, assemblyPath, conditionalDocument, typeof(WitnessConditionalForm).FullName!, 0, 0, null, 1, "",
                    typeof(UserControl).FullName!,
                })!;
                Assert.Equal("compiledFallback", (string)Get(branched, "RenderMode"));
                Assert.Equal("unrepresentableStatements", (string)Get(branched, "FallbackReason"));
            }
            finally
            {
                try { worker.GetType().GetMethod("DiscardLive")!.Invoke(worker, new object?[] { assemblyPath, rootType, designerPath }); } catch { }
                try { File.Delete(designerPath); } catch { }
            }
        }

        private static object Get(object instance, string propertyName) =>
            instance.GetType().GetProperty(propertyName)!.GetValue(instance)!;

        private static Assembly Net48EngineAssembly()
        {
            var config = typeof(BuildWitnessTests).Assembly
                .GetCustomAttribute<AssemblyConfigurationAttribute>()?.Configuration ?? "Debug";
            var dir = new DirectoryInfo(AppContext.BaseDirectory);
            while (dir != null && !Directory.Exists(Path.Combine(dir.FullName, "engine-net48"))) dir = dir.Parent;
            Assert.NotNull(dir);
            var enginePath = Path.Combine(dir!.FullName, "engine-net48", "bin", config, "net48", "WinFormsDesigner.Engine.Net48.exe");
            Assert.True(File.Exists(enginePath), "Expected built net48 engine at " + enginePath);
            return Assembly.LoadFrom(enginePath);
        }
    }

    /// <summary>A form with a member named like the first part of an enum's name.</summary>
    public sealed class WitnessShadowingForm : UserControl
    {
        public object Shadowing = new object();
    }
}

namespace Engine.Net48.UnitTests.Shadow.Engine.Net48.UnitTests
{
    /// <summary>The same dotted name, relative to another namespace of the file.</summary>
    public sealed class WitnessButton { }
}

namespace Shadowing
{
    public enum WitnessKind { None, Combo }
}

namespace Engine.Net48.UnitTests.PrefixShadow
{
    /// <summary>A type named like the first part of `Engine.Net48.UnitTests.WitnessButton`.</summary>
    public sealed class Engine { }
}

namespace System.Runtime.CompilerServices
{
    /// <summary>The C# 13 attribute, absent from the .NET Framework; the witness recognizes it by its full name.</summary>
    [AttributeUsage(AttributeTargets.Method | AttributeTargets.Constructor | AttributeTargets.Property, Inherited = false)]
    internal sealed class OverloadResolutionPriorityAttribute : Attribute
    {
        public OverloadResolutionPriorityAttribute(int priority) { Priority = priority; }
        public int Priority { get; }
    }
}
