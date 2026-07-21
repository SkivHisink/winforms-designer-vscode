using System;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The interpreted-render PLAN: the shared pipeline from a parsed IR to a live root, or a named
    // compiled fallback. This is the VS model end to end: cover-check → resolve + instantiate the immediate BASE
    // type → replay the derived source's IR onto it (executor) → classify. The render child domain calls this with a
    // real AssemblyIrHost, then hosts the returned root off-screen and Snapshots it exactly like the compiled path.
    //
    // Every non-interpreted outcome is a NAMED fallback (no silent partial): coverage gap, a base the compiled
    // assembly no longer has (baseTypeChanged — the stale-type handshake required), a base ctor that threw, or
    // an executor abort. Shared/BCL-only, so it is fully unit-testable on both runtimes with real base/derived types.
    // ============================================================================================================
    public sealed class InterpretedRenderPlan
    {
        /// <summary>True only when the IR fully covered the form AND the executor produced a complete live tree.</summary>
        public bool Interpreted { get; private set; }
        public RenderModeDecision Decision { get; private set; } = RenderModeDecision.Fallback(RenderFallbackReason.NoFormClass);
        /// <summary>The live root (a Control) when Interpreted; may be a partly-built root on a late fallback (the
        /// caller disposes it and renders compiled instead).</summary>
        public object? Root { get; private set; }
        public IrExecutionResult? Execution { get; private set; }
        public string DesignedTypeName { get; private set; } = "";

        public static InterpretedRenderPlan Plan(IrDocument? doc, IIrHost host) => Plan(doc, host, null);

        /// <param name="baseTypeOverride">The BASE type to instantiate, resolved by the caller from the COMPILED
        /// designed type's <c>BaseType</c> — the reliable source, since a VS form declares its base in the NON-designer
        /// partial the front-end never sees. Null ⇒ resolve from the source's declared base name (used by unit tests
        /// whose base IS in the parsed source).</param>
        public static InterpretedRenderPlan Plan(IrDocument? doc, IIrHost host, Type? baseTypeOverride)
        {
            if (host == null) throw new ArgumentNullException(nameof(host));

            var coverage = RenderModeClassifier.FromCoverage(doc);
            if (coverage.Mode == RenderMode.CompiledFallback)
                return new InterpretedRenderPlan { Interpreted = false, Decision = coverage, DesignedTypeName = doc?.DesignedTypeName ?? "" };

            var designed = doc!.DesignedTypeName;

            // Resolve the immediate BASE type. Prefer the caller's reflection-resolved base (from the compiled designed
            // type); otherwise resolve the source's declared base name. Absent ⇒ the live source declares a base the
            // build doesn't have (edited base, not yet rebuilt) — the stale-type handshake: fall back rather than replay
            // onto a stale compiled base.
            var baseType = baseTypeOverride ?? host.ResolveType(doc.BaseTypeSyntaxName);
            if (baseType == null)
                return Fallback(designed, RenderFallbackReason.BaseTypeChanged, "base type not in build: " + doc.BaseTypeSyntaxName);

            object root;
            try { root = CompiledRootFactory.Create(baseType); }
            catch (Exception ex)
            {
                return Fallback(designed, RenderFallbackReason.ExecutorFailure, "base ctor: " + ex.GetType().Name + ": " + ex.Message);
            }

            IrExecutionResult exec;
            try
            {
                exec = DesignerIrExecutor.Execute(doc, root, host);
            }
            catch (Exception ex)
            {
                // The executor is fail-closed (it returns Ok=false, and per-member replay is guarded). An UNEXPECTED
                // exception still escaping it (e.g. a vendor member access no guard anticipated) must NOT strand the
                // constructed root — return a named fallback that CARRIES the root, so the caller's uniform disposal
                // tears it down. Plan owns teardown of what Plan built; without this the root leaks (the caller's
                // `plan` is null when Plan throws, so its finally can't reach the constructed Form).
                return new InterpretedRenderPlan
                {
                    Interpreted = false,
                    Decision = RenderModeDecision.Fallback(RenderFallbackReason.ExecutorFailure,
                        "executor threw: " + ex.GetType().Name + ": " + ex.Message),
                    Root = root,
                    DesignedTypeName = designed,
                };
            }
            var decision = RenderModeClassifier.FromExecution(exec);
            return new InterpretedRenderPlan
            {
                Interpreted = decision.Mode == RenderMode.Interpreted,
                Decision = decision,
                Root = root,
                Execution = exec,
                DesignedTypeName = designed,
            };
        }

        private static InterpretedRenderPlan Fallback(string designed, string reason, string detail) =>
            new InterpretedRenderPlan
            {
                Interpreted = false,
                Decision = RenderModeDecision.Fallback(reason, detail),
                DesignedTypeName = designed,
            };
    }
}
