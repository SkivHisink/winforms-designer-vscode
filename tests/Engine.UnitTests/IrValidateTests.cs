using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// The STRUCTURAL security gate. IrValidate.Check is the SAME code the child-domain executor
// runs FIRST on every incoming document (parser-side checks are necessary
// but the child re-runs them — nothing is trusted across the AppDomain boundary). These tests forge malformed
// documents DIRECTLY (not via the parser) — the adversary's position — and prove each is refused with a reason, and
// that validation is pure inspection: no construction, no reflection-invoke, no side effect can occur inside Check.
// The executor's SEMANTIC canary (an IR that would run compiled code) is a follow-up test once the executor exists.
public sealed class IrValidateTests
{
    private static IrDocument WellFormed() => new()
    {
        DesignedTypeName = "Demo.Form1",
        BaseTypeSyntaxName = "System.Windows.Forms.Form",
        TotalSourceStatements = 2,
        RepresentedStatements = 2,
        Statements =
        {
            new IrConstructComponent { Name = "button1", TypeName = "System.Windows.Forms.Button" },
            new IrSetProperty
            {
                TargetIsRoot = false, TargetName = "button1", PropertyPath = { "Text" },
                Value = new IrString { Value = "ok" },
            },
        },
    };

    [Fact]
    public void WellFormedDocument_Passes() => Assert.Null(IrValidate.Check(WellFormed()));

    [Fact]
    public void NullDocument_Refused() => Assert.NotNull(IrValidate.Check(null));

    [Fact]
    public void UnknownSchemaVersion_Refused()
    {
        var d = WellFormed();
        d.SchemaVersion = IrLimits.SchemaVersion + 1;
        Assert.NotNull(IrValidate.Check(d));
    }

    [Theory]
    [InlineData("x;System.Diagnostics.Process.Start(\"calc\")")] // statement-injection attempt
    [InlineData("butтon1")] // Cyrillic 'т' homoglyph
    [InlineData("1button")]      // not an identifier
    [InlineData("")]             // empty
    public void ForgedComponentName_NonIdentifier_Refused(string name)
    {
        var d = WellFormed();
        ((IrConstructComponent)d.Statements[0]).Name = name;
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void ForgedTypeName_NonType_Refused()
    {
        var d = WellFormed();
        ((IrConstructComponent)d.Statements[0]).TypeName = "System.Windows.Forms.Button, EvilAssembly"; // no commas in a type name
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void OverBudget_StatementCount_Refused()
    {
        var d = WellFormed();
        for (int i = 0; i < IrLimits.MaxStatements + 1; i++)
            d.Statements.Add(new IrBeginInit { TargetName = "button1" });
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void OverBudget_ValueNestingDepth_Refused()
    {
        // (byte)(byte)(byte)… deeper than MaxValueDepth — a crafted graph that would blow the executor's stack.
        IrValue v = new IrNumber { Kind = IrNumericKind.Int32, InvariantText = "1" };
        for (int i = 0; i < IrLimits.MaxValueDepth + 2; i++) v = new IrCast { TargetTypeName = "System.Byte", Inner = v };
        var d = WellFormed();
        ((IrSetProperty)d.Statements[1]).Value = v;
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void OverBudget_PropertyPathLength_Refused()
    {
        var d = WellFormed();
        var set = (IrSetProperty)d.Statements[1];
        set.PropertyPath.Clear();
        for (int i = 0; i < IrLimits.MaxPathLength + 1; i++) set.PropertyPath.Add("Hop" + i);
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void EmptyPropertyPath_Refused()
    {
        var d = WellFormed();
        ((IrSetProperty)d.Statements[1]).PropertyPath.Clear();
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void PropertyPath_NonIdentifierSegment_Refused()
    {
        var d = WellFormed();
        var set = (IrSetProperty)d.Statements[1];
        set.PropertyPath.Clear();
        set.PropertyPath.Add("Options.Appearance"); // a dotted segment is an unflattened injection, not one hop
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void InvalidEnum_EmptyOrOverBudgetMembers_Refused()
    {
        var empty = WellFormed();
        ((IrSetProperty)empty.Statements[1]).Value = new IrEnum { EnumTypeName = "System.Windows.Forms.AnchorStyles", Members = new List<string>() };
        Assert.NotNull(IrValidate.Check(empty));

        var over = WellFormed();
        var many = Enumerable.Range(0, IrLimits.MaxEnumMembers + 1).Select(i => "M" + i).ToList();
        ((IrSetProperty)over.Statements[1]).Value = new IrEnum { EnumTypeName = "System.Windows.Forms.AnchorStyles", Members = many };
        Assert.NotNull(IrValidate.Check(over));
    }

    [Fact]
    public void InvalidNumericLiteral_Refused()
    {
        var d = WellFormed();
        ((IrSetProperty)d.Statements[1]).Value = new IrNumber { Kind = IrNumericKind.Int32, InvariantText = "" };
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void RootRefCarryingAName_Refused()
    {
        var d = WellFormed();
        ((IrSetProperty)d.Statements[1]).Value = new IrComponentRef { IsRoot = true, Name = "smuggled" };
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void NullStatement_Refused()
    {
        var d = WellFormed();
        d.Statements.Add(null!);
        Assert.NotNull(IrValidate.Check(d));
    }

    [Fact]
    public void InvalidCoverageCounts_Refused()
    {
        var d = WellFormed();
        d.RepresentedStatements = d.TotalSourceStatements + 1; // represented more than exist
        Assert.NotNull(IrValidate.Check(d));
    }

    // DRIFT GUARD: the closed vocabulary IrValidate walks MUST list every sealed IR node type in the assembly.
    // Adding a node class without registering it in the Closed set would let the executor see an un-validated node —
    // this test fails the instant that happens, forcing the security registration (make the invariant
    // structural, not aspirational).
    [Fact]
    public void EveryIrNodeType_IsInClosedValidationSet()
    {
        var asm = typeof(IrValidate).Assembly;
        var nodeBases = new[] { typeof(IrStatement), typeof(IrValue) };
        var concrete = asm.GetTypes()
            .Where(t => t.IsClass && !t.IsAbstract && nodeBases.Any(b => b.IsAssignableFrom(t)))
            .ToList();
        Assert.NotEmpty(concrete);

        // Reflect the private Closed set (the single registry) and assert it equals the set of concrete node types.
        var closedField = typeof(IrValidate).GetField("Closed", BindingFlags.NonPublic | BindingFlags.Static);
        Assert.NotNull(closedField);
        var closed = (HashSet<Type>)closedField!.GetValue(null)!;

        var missing = concrete.Where(t => !closed.Contains(t)).Select(t => t.Name).ToList();
        Assert.True(missing.Count == 0, "IR node types missing from IrValidate.Closed (unvalidated!): " + string.Join(", ", missing));

        // and every sealed node must actually be sealed (no subclass smuggling via inheritance).
        var unsealed = concrete.Where(t => !t.IsSealed).Select(t => t.Name).ToList();
        Assert.True(unsealed.Count == 0, "IR node types must be sealed: " + string.Join(", ", unsealed));
    }

    [Fact] // A document under the node/per-string caps but with a multi-GB AGGREGATE string payload is refused.
    public void AggregateStringBudget_Exceeded_IsRefused()
    {
        // Each string is under MaxStringLength (1 MiB) and the node count is tiny, but the total exceeds the aggregate
        // char budget — the exact "10k × 1 MiB array passes both individual caps" DoS shape.
        var big = new string('x', 1 << 20); // 1 MiB, individually legal
        var items = new List<IrValue>();
        for (int i = 0; i < 40; i++) items.Add(new IrString { Value = big }); // 40 MiB aggregate > 32 Mi-char budget
        var doc = new IrDocument
        {
            DesignedTypeName = "Demo.Form1", BaseTypeSyntaxName = "System.Windows.Forms.Form",
            TotalSourceStatements = 1, RepresentedStatements = 1,
            Statements =
            {
                new IrSetProperty
                {
                    TargetIsRoot = true, PropertyPath = { "Tag" },
                    Value = new IrArray { ElementTypeName = "System.String", Items = items },
                },
            },
        };
        Assert.Equal("string budget exceeded", IrValidate.Check(doc));
    }

    [Fact] // A forged null UnrepresentableReasons is refused, not dereferenced.
    public void NullUnrepresentableReasons_IsRefused()
    {
        var doc = WellFormed();
        doc.UnrepresentableReasons = null!;
        Assert.Equal("UnrepresentableReasons is null", IrValidate.Check(doc));
    }

    [Fact] // A forged null TargetName is refused with a reason, not an NRE inside ValidTarget.
    public void NullTargetName_IsRefused_NoThrow()
    {
        var doc = WellFormed();
        doc.Statements.Add(new IrSetProperty { TargetIsRoot = false, TargetName = null!, PropertyPath = { "Text" }, Value = new IrString { Value = "x" } });
        var reason = IrValidate.Check(doc); // must return a reason, never throw
        Assert.NotNull(reason);
    }

    [Fact] // Resource keys count toward the aggregate budget (they were previously uncounted, so a
    // nested array of many 512-char keys bypassed both the per-string cap and the node budget).
    public void AggregateStringBudget_ResourceKeys_Counted()
    {
        var key = new string('k', 512);
        var outer = new List<IrValue>();
        for (int g = 0; g < 25; g++) // 25 x 7000 = 175,000 keys x 512 = ~89.6M chars > 33.5M budget; nodes stay < 200k
        {
            var inner = new List<IrValue>();
            for (int i = 0; i < 7000; i++) inner.Add(new IrResourceRef { Key = key, IsString = true });
            outer.Add(new IrArray { ElementTypeName = "System.Object", Items = inner });
        }
        var doc = new IrDocument
        {
            DesignedTypeName = "Demo.F", BaseTypeSyntaxName = "System.Windows.Forms.Form",
            TotalSourceStatements = 1, RepresentedStatements = 1,
            Statements = { new IrSetProperty { TargetIsRoot = true, PropertyPath = { "Tag" }, Value = new IrArray { ElementTypeName = "System.Object", Items = outer } } },
        };
        Assert.Equal("string budget exceeded", IrValidate.Check(doc));
    }
}
