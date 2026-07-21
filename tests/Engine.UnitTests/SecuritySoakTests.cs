using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Windows.Forms;
using WinFormsDesigner.Engine;

namespace Engine.UnitTests;

// The RCE-on-open boundary, adversarially. A FORGED IrDocument (bypassing the syntax-only parser) is
// the attacker's position: it can carry any known-kind node. These tests prove the child-side executor refuses every
// value-path node that would run non-trusted code — a construction, a static factory, or a static read of a type NOT
// on the allowlist — BEFORE any side effect fires. A SIDE-EFFECT CANARY (a static flag flipped by evil ctor/method/
// getter) must stay false through the whole soak.
//
// Scope note: constructing a field-backed COMPONENT (IrConstructComponent) DOES run its compiled ctor — that is the
// documented trusted-to-execute model (VS instantiates compiled controls). The boundary this soak defends is the
// INLINE VALUE expression surface (IrKnownCtor / IrStaticFactory / IrStaticRead), which must never run arbitrary code.
// TOP-LEVEL evil types so their reflection name == their dotted IR name (a nested type would need '+') — this makes
// them RESOLVE, proving the ALLOWLIST (not mere non-resolution) is what refuses them.
public static class Canary { public static bool Fired; }

// An "evil" value type whose CONSTRUCTION has a side effect — the shape a hostile .Designer.cs would try to run as an
// inline property value (e.g. `this.x.Tag = new EvilValue()`). NOT on the construction allowlist.
public sealed class EvilValue { public EvilValue() { Canary.Fired = true; } }
public static class EvilFactory { public static object Detonate() { Canary.Fired = true; return new object(); } }
public static class EvilStatics { public static object Trigger { get { Canary.Fired = true; return new object(); } } }

// A vendor component gated by a design-time license — its ctor throws LicenseException (the DevExpress/lc.exe pattern).
public sealed class LicensedComponent : System.ComponentModel.Component
{
    public LicensedComponent() => throw new System.ComponentModel.LicenseException(typeof(LicensedComponent), null, "design-time license required");
}

// An IExtenderProvider with a NON-advertised, side-effecting 2-arg Set* method. Implementing
// IExtenderProvider must NOT make every public Set* invokable from source; only a [ProvideProperty]-advertised setter
// is an extender property. SetCommand here is a decoy the boundary must refuse.
[System.ComponentModel.ProvideProperty("Hint", typeof(Control))]
public sealed class ExtenderWithDecoy : System.ComponentModel.Component, System.ComponentModel.IExtenderProvider
{
    public bool CanExtend(object target) => target is Control;
    public string GetHint(Control c) => "";
    public void SetHint(Control c, string v) { }                        // the real, advertised extender property
    public void SetCommand(Control c, string v) { Canary.Fired = true; } // NOT advertised — must be refused
}

public sealed class SecuritySoakTests
{
    private sealed class ResolvingHost : IIrHost
    {
        private static readonly Assembly[] Probe =
        {
            typeof(SecuritySoakTests).Assembly, // so the evil types RESOLVE — proving the allowlist (not mere
            typeof(Control).Assembly, typeof(Color).Assembly, typeof(object).Assembly, // absence) is what refuses them
        };
        public Type? ResolveType(string n)
        {
            foreach (var a in Probe) { var t = a.GetType(n, false); if (t != null) return t; }
            return Type.GetType(n, false);
        }
        public object CreateComponent(Type t, string name, bool withContainer) => Activator.CreateInstance(t)!;
        public object? ResolveResource(string k, bool s) => null;
        public bool WasResourceRefused(string key) => false;
    }

    private static IrDocument OneValue(IrValue value) => new()
    {
        DesignedTypeName = "Demo.F", BaseTypeSyntaxName = "System.Windows.Forms.Form",
        TotalSourceStatements = 1, RepresentedStatements = 1,
        Statements = { new IrSetProperty { TargetIsRoot = true, PropertyPath = { "Tag" }, Value = value } },
    };

    private static string RunEvil(IrValue evil)
    {
        Canary.Fired = false;
        var res = DesignerIrExecutor.Execute(OneValue(evil), new Form(), new ResolvingHost());
        Assert.False(res.Ok); // refused
        Assert.False(Canary.Fired, "the side-effect canary MUST NOT fire — evil code ran before/despite refusal");
        return res.FailureReason ?? "";
    }

    [Fact]
    public void ForgedEvilConstruction_Refused_CanaryNeverFires()
    {
        var t = typeof(EvilValue).FullName!.Replace('+', '.'); // reflection uses '+', IR type names use '.'
        Assert.Contains("construction not allowed", RunEvil(new IrKnownCtor { TypeName = t }));
    }

    [Fact]
    public void ForgedEvilStaticFactory_Refused_CanaryNeverFires()
    {
        var t = typeof(EvilFactory).FullName!.Replace('+', '.');
        Assert.Contains("factory not allowed", RunEvil(new IrStaticFactory { TypeName = t, Method = "Detonate" }));
    }

    [Fact]
    public void ForgedEvilStaticRead_Refused_CanaryNeverFires()
    {
        var t = typeof(EvilStatics).FullName!.Replace('+', '.');
        Assert.Contains("static read not allowed", RunEvil(new IrStaticRead { TypeName = t, Member = "Trigger" }));
    }

    [Fact]
    public void EvilNestedInsideCastAndArray_StillRefused_CanaryNeverFires()
    {
        var t = typeof(EvilValue).FullName!.Replace('+', '.');
        // buried inside a cast → the executor materializes the inner value, hits the allowlist, refuses.
        RunEvil(new IrCast { TargetTypeName = "System.Object", Inner = new IrKnownCtor { TypeName = t } });
        // and inside an array element.
        RunEvil(new IrArray { ElementTypeName = "System.Object", Items = { new IrKnownCtor { TypeName = t } } });
    }

    [Fact]
    public void EvilAsAKnownCtorArgument_StillRefused_CanaryNeverFires()
    {
        var t = typeof(EvilValue).FullName!.Replace('+', '.');
        // an allowlisted ctor (Point) with an EVIL argument — the argument is materialized first and refused, so the
        // Point is never constructed and the canary never fires.
        Canary.Fired = false;
        var doc = OneValue(new IrKnownCtor { TypeName = "System.Drawing.Point", Args = { new IrKnownCtor { TypeName = t } } });
        var res = DesignerIrExecutor.Execute(doc, new Form(), new ResolvingHost());
        Assert.False(res.Ok);
        Assert.False(Canary.Fired);
    }

    [Fact]
    public void LicenseGatedComponent_ClassifiedAsLicenseRequired_NotAGenericCrash()
    {
        // Licensing: a vendor control whose ctor throws LicenseException is a distinct, precise fallback reason.
        var doc = new IrDocument
        {
            DesignedTypeName = "Demo.F", BaseTypeSyntaxName = "System.Windows.Forms.Form",
            TotalSourceStatements = 1, RepresentedStatements = 1,
            Statements = { new IrConstructComponent { Name = "vendor1", TypeName = typeof(LicensedComponent).FullName!.Replace('+', '.') } },
        };
        var res = DesignerIrExecutor.Execute(doc, new Form(), new ResolvingHost());
        Assert.False(res.Ok);
        Assert.StartsWith("LICENSE:", res.FailureReason);
        var mode = RenderModeClassifier.FromExecution(res);
        Assert.Equal(RenderFallbackReason.LicenseRequired, mode.FallbackReason);
    }

    [Fact]
    public void MalformedForgedGraphs_AreRefused_NoUnhandledThrow_NoCanary()
    {
        // A deterministic fuzz over hostile shapes: unknown enum members, bad numeric literals, invalid targets,
        // over-deep casts, invalid property paths. Every one must be refused (validator or executor), never throw out,
        // and never fire the canary.
        Canary.Fired = false;
        var host = new ResolvingHost();
        var evils = new List<IrValue>
        {
            new IrEnum { EnumTypeName = "System.Windows.Forms.AnchorStyles", Members = { "NotAReal_Member" } },
            new IrNumber { Kind = IrNumericKind.Int32, InvariantText = "not-a-number" },
            new IrComponentRef { IsRoot = false, Name = "never_constructed" },
            new IrStaticRead { TypeName = "System.Environment", Member = "MachineName" },
            new IrResourceRef { Key = "missing", IsString = false },
        };
        foreach (var v in evils)
        {
            IrExecutionResult res;
            try { res = DesignerIrExecutor.Execute(OneValue(v), new Form(), host); }
            catch (Exception ex) { Assert.Fail("executor let an exception escape (must fail closed): " + ex.GetType().Name + " " + ex.Message); return; }
            Assert.False(res.Ok);
        }
        Assert.False(Canary.Fired);
    }

    [Fact] // A Type-side allowlist check requires a TRUSTED framework assembly, not FullName alone.
    public void AllowlistGate_RequiresTrustedFrameworkAssembly()
    {
        // Framework types that are name-allowlisted pass BOTH gates.
        Assert.True(DesignerAllowlists.IsTrustedFrameworkType(typeof(Color)));
        Assert.True(DesignerAllowlists.IsStaticReadAllowed(typeof(Color)));
        Assert.True(DesignerAllowlists.IsConstructionAllowed(typeof(Point)));
        Assert.True(DesignerAllowlists.IsFactoryInvocationAllowed(typeof(Color), "FromArgb"));
        // A user/test-assembly type is NEVER trusted — this is what defeats a project that ships its own
        // `System.Drawing.Color` (probed before the framework) to run a side-effecting getter on preview-open.
        Assert.False(DesignerAllowlists.IsTrustedFrameworkType(typeof(EvilStatics)));
        Assert.False(DesignerAllowlists.IsStaticReadAllowed(typeof(EvilStatics)));
        Assert.False(DesignerAllowlists.IsConstructionAllowed(typeof(EvilValue)));
    }

    [Fact] // A non-advertised extender Set* method is refused, and no side effect fires.
    public void ForgedExtender_NonAdvertisedSetter_Refused()
    {
        Canary.Fired = false;
        var doc = new IrDocument
        {
            DesignedTypeName = "Demo.F", BaseTypeSyntaxName = "System.Windows.Forms.Form",
            TotalSourceStatements = 3, RepresentedStatements = 3,
            Statements =
            {
                new IrConstructComponent { Name = "prov", TypeName = typeof(ExtenderWithDecoy).FullName! },
                new IrConstructComponent { Name = "btn", TypeName = "System.Windows.Forms.Button" },
                new IrSetExtender { ProviderName = "prov", TargetName = "btn", PropertyName = "Command", Value = new IrString { Value = "x" } },
            },
        };
        var res = DesignerIrExecutor.Execute(doc, new Form(), new ResolvingHost());
        Assert.False(res.Ok);
        Assert.Contains("not an advertised extender property", res.FailureReason);
        Assert.False(Canary.Fired);
    }

    [Fact] // A real, advertised extender property still applies (the fix doesn't break legitimate extenders).
    public void Extender_AdvertisedSetter_Applies()
    {
        var doc = new IrDocument
        {
            DesignedTypeName = "Demo.F", BaseTypeSyntaxName = "System.Windows.Forms.Form",
            TotalSourceStatements = 3, RepresentedStatements = 3,
            Statements =
            {
                new IrConstructComponent { Name = "prov", TypeName = typeof(ExtenderWithDecoy).FullName! },
                new IrConstructComponent { Name = "btn", TypeName = "System.Windows.Forms.Button" },
                new IrSetExtender { ProviderName = "prov", TargetName = "btn", PropertyName = "Hint", Value = new IrString { Value = "help" } },
            },
        };
        var res = DesignerIrExecutor.Execute(doc, new Form(), new ResolvingHost());
        Assert.True(res.Ok, res.FailureReason);
    }
}
