using System.Linq;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The per-form render-mode decision + STABLE, machine-readable fallback reason codes.
    //
    // The host models two axes — engineKind (modern | net48) × renderMode
    // (interpreted | compiledFallback) — and drives banner / status / undo / edit-routing from the last successful
    // render's mode. This is the engine-side authority for that per-form `renderMode` and its reason: interpreted
    // when the closed IR fully covers InitializeComponent AND the executor succeeded; a named, disclosed compiled
    // fallback otherwise. There is NO silent partial interpreted render — every non-full or failed result is a
    // fallback with a reason ("any interpreted render is silently partial or materially wrong").
    //
    // Reason codes are a CLOSED, stable vocabulary the TS host switches on — never free text (the Detail carries the
    // human string). Adding a reason means adding it here and teaching the host.
    // ============================================================================================================

    public enum RenderMode { Interpreted, CompiledFallback }

    public static class RenderFallbackReason
    {
        public const string NoFormClass = "noFormClass"; // no unique form class resolved (fail-closed identity)
        public const string InitNotFound = "initNotFound"; // InitializeComponent absent
        public const string UnrepresentableStatements = "unrepresentableStatements"; // coverage gap in the IR
        public const string ExecutorFailure = "executorFailure"; // executor aborted (semantic/security/init)
        public const string UnsafeBinaryResource = "unsafeBinaryResource"; // binary/SOAP/FileRef resx — fallback
        public const string BaseTypeChanged = "baseTypeChanged"; // live source's base ≠ compiled base (rebuild)
        public const string LicenseRequired = "licenseRequired"; // a vendor control's design-time license gate
    }

    public sealed class RenderModeDecision
    {
        public RenderMode Mode { get; }
        /// <summary>A stable code from <see cref="RenderFallbackReason"/> when <see cref="Mode"/> is
        /// CompiledFallback; null when Interpreted.</summary>
        public string? FallbackReason { get; }
        /// <summary>Human detail for logs/diagnostics — NEVER switched on by the host.</summary>
        public string? Detail { get; }

        private RenderModeDecision(RenderMode mode, string? reason, string? detail)
        {
            Mode = mode; FallbackReason = reason; Detail = detail;
        }

        public static RenderModeDecision Interpreted() => new RenderModeDecision(RenderMode.Interpreted, null, null);
        public static RenderModeDecision Fallback(string reason, string? detail = null) =>
            new RenderModeDecision(RenderMode.CompiledFallback, reason, detail);
    }

    public static class RenderModeClassifier
    {
        /// <summary>PRE-execution decision from the front-end's coverage. A form the interpreter can't fully cover is
        /// a named compiled fallback; only a fully-covered form proceeds to execution.</summary>
        public static RenderModeDecision FromCoverage(IrDocument? doc)
        {
            if (doc == null) return RenderModeDecision.Fallback(RenderFallbackReason.NoFormClass);
            // Null-safe: a forged doc could carry a null list, and this classifier runs BEFORE IrValidate.Check in the
            // plan — never dereference it directly.
            var reasons = doc.UnrepresentableReasons ?? new System.Collections.Generic.List<string>();
            if (reasons.Any(r => r != null && r.StartsWith("InitializeComponent not found")))
                return RenderModeDecision.Fallback(RenderFallbackReason.InitNotFound);
            if (!doc.FullCoverage)
                return RenderModeDecision.Fallback(
                    RenderFallbackReason.UnrepresentableStatements,
                    string.Join(" | ", reasons.Take(5)));
            return RenderModeDecision.Interpreted();
        }

        /// <summary>POST-execution decision. A fully-covered form whose executor aborted still falls back (with the
        /// executor's reason) rather than Snapshotting a partial tree.</summary>
        public static RenderModeDecision FromExecution(IrExecutionResult result)
        {
            if (result.Ok) return RenderModeDecision.Interpreted();
            // A design-time license gate is a distinct, precise reason (the executor prefixes it) — not a generic
            // failure. Everything else is executorFailure with the raw reason as detail.
            if (result.FailureReason != null && result.FailureReason.StartsWith("LICENSE:"))
                return RenderModeDecision.Fallback(RenderFallbackReason.LicenseRequired, result.FailureReason.Substring("LICENSE:".Length));
            // A refused binary/SOAP/file-ref resource is a distinct, precise reason (the executor prefixes it) — the
            // host can then disclose "unsafe resource" rather than a generic executor failure.
            if (result.FailureReason != null && result.FailureReason.StartsWith("UNSAFE_RESOURCE:"))
                return RenderModeDecision.Fallback(RenderFallbackReason.UnsafeBinaryResource, result.FailureReason.Substring("UNSAFE_RESOURCE:".Length));
            return RenderModeDecision.Fallback(RenderFallbackReason.ExecutorFailure, result.FailureReason);
        }
    }
}
