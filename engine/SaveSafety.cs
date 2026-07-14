using System.Collections.Generic;

namespace WinFormsDesigner.Engine
{
    /// <summary>Categorized reason a form is / isn't safe to whole-file regenerate (save-splice).</summary>
    public enum SaveSafetyReason
    {
        /// <summary>Fully round-trips: renders AND re-serialization reproduces every original statement.</summary>
        Safe,
        /// <summary>[Localizable(true)] → ApplyResources; the real values live in the sibling .resx and the net9
        /// preview can't reproduce them (read-only lock, 0.10.0 S1).</summary>
        Localizable,
        /// <summary>The sibling .resx holds BinaryFormatter/SOAP/ImageStream resources net9 can't serialize
        /// (PlatformNotSupportedException) → the whole file is read-only for regenerate (0.10.0 S3).</summary>
        BinaryResx,
        /// <summary>A control type couldn't be loaded/interpreted on net9 (vendor/custom control) → the net48
        /// compiled engine renders it, but net9 can't whole-file round-trip it.</summary>
        UnresolvedType,
        /// <summary>Renders fully (RoundTripSafe) yet re-serialization drops or alters an original statement
        /// (e.g. TabPages.AddRange canonicalized, a Hidden component-ref, TreeNode local-variable naming). The
        /// safe-save gate refuses rather than silently lose it (fail-closed).</summary>
        LostStatements,
        /// <summary>Some other interpret failure (unrecognized hand-edit / unsupported construct).</summary>
        Unrepresentable,
    }

    /// <summary>
    /// Capability preflight. The AUTHORITATIVE "is this form safe to whole-file regenerate/save" predicate is
    /// <see cref="SaveResult.Safe"/> (RoundTripSafe AND a splice was produced AND no original statement is lost) —
    /// NOT <c>RoundTripSafe</c> alone, which is render-only and over-optimistic: a form can render fully yet lose
    /// statements on re-serialization (an ISupportInitialize pre-0.12.0 form, TabPages.AddRange, TreeView node
    /// locals…). Any regenerate-based capability (whole-file save, Modifiers/GenerateMember via regenerate) must
    /// gate on <see cref="SaveResult.Safe"/>; <see cref="Classify"/> explains WHY when it isn't, so callers can
    /// surface an honest reason instead of a misleading "PASS".
    /// </summary>
    public static class SaveSafety
    {
        /// <summary>Classify the read-only reason from the interpret + save-gate signals. Precedence (most specific
        /// cause first): Localizable → BinaryResx → UnresolvedType → other Unrepresentable → LostStatements → Safe.</summary>
        public static SaveSafetyReason Classify(IReadOnlyList<string> unrepresentable, IReadOnlyList<string> missingStatements)
        {
            bool anyUnrep = unrepresentable.Count > 0;
            foreach (var u in unrepresentable)
            {
                if (u.Contains("ApplyResources")) return SaveSafetyReason.Localizable;
            }
            foreach (var u in unrepresentable)
            {
                if (u.Contains("binary serialized resources")) return SaveSafetyReason.BinaryResx;
            }
            foreach (var u in unrepresentable)
            {
                if (u.Contains("unresolved type") || u.Contains("unrecognized LHS") || u.Contains("Controls.Add unknown child"))
                    return SaveSafetyReason.UnresolvedType;
            }
            if (anyUnrep) return SaveSafetyReason.Unrepresentable;
            if (missingStatements.Count > 0) return SaveSafetyReason.LostStatements;
            return SaveSafetyReason.Safe;
        }

        /// <summary>camelCase category token (stable wire/diagnostic id, shared by CLI, the PreviewSave RPC and the
        /// golden-corpus test).</summary>
        public static string CategoryName(SaveSafetyReason r) => r switch
        {
            SaveSafetyReason.Safe => "safe",
            SaveSafetyReason.Localizable => "localizable",
            SaveSafetyReason.BinaryResx => "binaryResx",
            SaveSafetyReason.UnresolvedType => "unresolvedType",
            SaveSafetyReason.LostStatements => "lostStatements",
            _ => "unrepresentable",
        };
    }
}
