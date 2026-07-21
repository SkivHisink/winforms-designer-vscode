using System;
using System.Collections.Generic;
using System.Reflection;

namespace WinFormsDesigner.Engine
{
    // ============================================================================================================
    // The interpreter's THREE security allowlists — the RCE-on-open boundary — in ONE place, COMPILE-LINKED into
    // both engines. The net10 interpreter (DesignerRenderer.Eval) and the net48 live-source parser
    // + child-domain executor must gate against the SAME sets, or the security boundary forks
    // silently.
    //
    // These answer exactly three questions about a construct in a hand-crafted .Designer.cs:
    // · IsConstructionAllowed(T) — may `new T(...)` run as an inline PROPERTY VALUE? (pure value structs only)
    // · IsFactoryInvocationAllowed(T, m) — may the static call `T.m(...)` run? (pure Color factories only)
    // · IsStaticReadAllowed(T) — may a static/property read off T run? (side-effect-free value sources)
    // Anything not listed becomes gracefully "unrepresentable" (interpreted) / a named fallback (net48) — never an
    // arbitrary constructor, file-reading BCL call, or user/vendor static getter executed merely on preview-open.
    //
    // Matched by FullName (not Assembly) so the sets survive assembly re-partitioning (the reason the original moved
    // off an assembly list for Padding, and why System.Drawing.Common entering the probe can't widen them).
    // ============================================================================================================
    public static class DesignerAllowlists
    {
        /// <summary>
        /// Static-invocation eval path: only the pure, side-effect-free Color factory methods the value-converter
        /// emits (and real designer files contain). Never "any static method in an allowed assembly" — that would
        /// still expose side-effecting calls like MessageBox.Show or Image.FromFile.
        /// </summary>
        private static readonly HashSet<string> AllowedStaticInvocations = new(StringComparer.Ordinal)
        {
            "System.Drawing.Color.FromArgb",
            "System.Drawing.Color.FromName",
            "System.Drawing.Color.FromKnownColor",
        };

        /// <summary>
        /// ObjectCreation eval path: the framework value types the designer legitimately CONSTRUCTS as inline
        /// property values (Point/Size/Rectangle/Padding + F-variants, Font/FontFamily, TableLayoutPanel
        /// Column/RowStyle). This is the ONLY thing constructable on open.
        ///
        /// History: this was a namespace check (System.Drawing*/System.Windows.Forms* wholesale) PLUS a branch
        /// allowing ANY type from a user/project ALC assembly. Both were unsafe:
        /// • the namespace check was safe only while System.Drawing.Common stayed OUT of the probe; once it's in
        /// (needed for Font), in-namespace file-reading ctors become reachable — new Bitmap(path)/Icon(path)/
        /// Metafile(path), plus the pre-existing in-probe new System.Windows.Forms.Cursor(path);
        /// • the userAsms branch let a hostile .Designer.cs run an ARBITRARY ctor of any type in the project's
        /// build output (or a planted sibling DLL auto-loaded from bin/) on preview-open — verified RCE-on-open.
        /// It was never needed for real controls: control instantiation goes through HandleAssignment ->
        /// host.CreateComponent (parameterless), never this gate. Eval ObjectCreation is only reached for inline
        /// PROPERTY VALUES, so dropping user-type construction just makes a custom value initializer gracefully
        /// unrepresentable instead of executing.
        /// </summary>
        private static readonly HashSet<string> AllowedConstructionTypes = new(StringComparer.Ordinal)
        {
            "System.Drawing.Point",
            "System.Drawing.PointF",
            "System.Drawing.Size",
            "System.Drawing.SizeF",
            "System.Drawing.Rectangle",
            "System.Drawing.RectangleF",
            "System.Windows.Forms.Padding",
            "System.Drawing.Font",
            "System.Drawing.FontFamily",
            // TableLayoutPanel column/row sizing — pure value initializers (SizeType enum + float), side-effect
            // free like Padding. Constructed inline in ColumnStyles/RowStyles.Add(new ColumnStyle/RowStyle(...)).
            "System.Windows.Forms.ColumnStyle",
            "System.Windows.Forms.RowStyle",
        };

        /// <summary>
        /// Declaring types whose public static property/field reads are allowed in the MemberAccess path. Only
        /// pure, side-effect-free framework value sources the value-converter emits: named/system colors
        /// (Color.Red, SystemColors.Control), the value structs' static members (Size.Empty, Point.Empty, …), and
        /// Cursors (pure static Cursor-valued properties). Excludes SystemFonts/SystemIcons/Brushes/Pens (newly
        /// reachable via Drawing.Common), corelib getters (Environment.MachineName), and user-DLL statics, whose
        /// getters could allocate handles or run side effects on open. Enum member reads go through Enum.Parse
        /// (always pure), not here.
        /// </summary>
        private static readonly HashSet<string> AllowedStaticReadTypes = new(StringComparer.Ordinal)
        {
            "System.Drawing.Color",
            "System.Drawing.SystemColors",
            "System.Drawing.Point",
            "System.Drawing.PointF",
            "System.Drawing.Size",
            "System.Drawing.SizeF",
            "System.Drawing.Rectangle",
            "System.Drawing.RectangleF",
            "System.Windows.Forms.Padding",
            "System.Windows.Forms.Cursors",
        };

        // CRITICAL: matching by FullName ALONE is a bypass. The net48 executor resolves a type via the host,
        // which probes the USER assembly FIRST — so a project that ships its own `System.Drawing.Color` with a
        // side-effecting `Red` getter would pass a FullName check and have its getter executed on preview-open. Every
        // Type-side gate therefore ALSO requires the resolved type to ORIGINATE from a trusted framework assembly. A
        // user cannot forge one: framework assemblies are strong-name-signed with Microsoft keys the user can't
        // reproduce, and here we anchor directly on the ACTUAL loaded framework assemblies that DEFINE the allowlisted
        // types (identical set on net48 and net10), so a shadow type in the user assembly is a reference mismatch.
        // The FullName-STRING overloads below stay name-only BY DESIGN: they run in the default domain with NO user
        // assemblies loaded (there is no Type, and nothing to impersonate) — the Type-side re-check is the real gate.
        private static readonly HashSet<Assembly> TrustedFrameworkAssemblies = new HashSet<Assembly>
        {
            typeof(object).Assembly, // corlib
            typeof(System.Drawing.Point).Assembly, // Point/Size/Rectangle/Color/SystemColors (Primitives on core)
            typeof(System.Drawing.Color).Assembly,
            typeof(System.Drawing.Font).Assembly, // Font/FontFamily (System.Drawing[.Common])
            typeof(System.Drawing.FontFamily).Assembly,
            typeof(System.Windows.Forms.Padding).Assembly, // Padding/Cursors/ColumnStyle/RowStyle (System.Windows.Forms)
            typeof(System.Windows.Forms.Cursors).Assembly,
            typeof(System.Windows.Forms.ColumnStyle).Assembly,
        };

        /// <summary>Whether a RESOLVED type comes from a trusted framework assembly — every allowlisted type does, and a
        /// user/vendor type (even one whose FullName impersonates an allowlisted one) does not. Anchored on the loaded
        /// framework assemblies, so it is correct on both net48 and net10.</summary>
        public static bool IsTrustedFrameworkType(Type? t) => t != null && TrustedFrameworkAssemblies.Contains(t.Assembly);

        public static bool IsFactoryInvocationAllowed(Type t, string methodName) =>
            t?.FullName != null && IsTrustedFrameworkType(t) && AllowedStaticInvocations.Contains(t.FullName + "." + methodName);

        public static bool IsConstructionAllowed(Type t) =>
            t?.FullName != null && IsTrustedFrameworkType(t) && AllowedConstructionTypes.Contains(t.FullName);

        public static bool IsStaticReadAllowed(Type t) =>
            t?.FullName != null && IsTrustedFrameworkType(t) && AllowedStaticReadTypes.Contains(t.FullName);

        // ---- FullName-STRING overloads for the syntax-only IR front-end --------------------------------
        // The parser runs in the default domain with NO user assemblies loaded, so it has no System.Type — it matches
        // the VS-canonical fully-qualified source prefix against the SAME private sets. Same boundary, one source.
        public static bool IsFactoryName(string typeFullName, string methodName) =>
            typeFullName != null && AllowedStaticInvocations.Contains(typeFullName + "." + methodName);

        public static bool IsConstructionName(string typeFullName) =>
            typeFullName != null && AllowedConstructionTypes.Contains(typeFullName);

        public static bool IsStaticReadName(string typeFullName) =>
            typeFullName != null && AllowedStaticReadTypes.Contains(typeFullName);
    }
}
