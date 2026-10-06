using System;
using System.ComponentModel;
using System.Reflection;
using Microsoft.CodeAnalysis.CSharp;

namespace WinFormsDesigner.Engine
{
    /// <summary>
    /// The ONE rule for editing a nested property such as a DevExpress button's <c>ImageOptions.Location</c>, shared by
    /// the describe side (which advertises a nested row as editable) and the write side (which accepts it), on both
    /// engines, so an offered edit and an accepted edit can never diverge.
    ///
    /// Visual Studio serializes such a value as <c>this.button1.ImageOptions.Location = …;</c> — a nested assignment —
    /// only when every hop is a reference object the owner exposes with
    /// <see cref="DesignerSerializationVisibility.Content"/> (the owner keeps the object; the designer edits it in
    /// place). That is exactly what is accepted here:
    /// <list type="bullet">
    /// <item>2–<see cref="MaxSegments"/> identifier segments;</item>
    /// <item>every hop a public instance property of a reference type, marked Content, that C# binds on the DECLARED
    /// type of the previous hop to the same member the live object has (a runtime subtype's extra or <c>new</c> members
    /// cannot be written in source), and that hands back the same object every time (an edit on a fresh copy is lost);</item>
    /// <item>the leaf a public settable property bound the same way, of a type the host writes as a plain literal
    /// (a non-[Flags] enum whose full name is a plain dotted identifier, string, bool, char, or a numeric
    /// primitive/decimal).</item>
    /// </list>
    /// The live side reads and writes through the source-bound CLR member, exactly as the compiled assignment does.
    /// Anything else stays a read-only metadata row.
    /// </summary>
    public static class NestedPropertyPath
    {
        public const int MinSegments = 2;
        public const int MaxSegments = 4;
        private const int MaxSegmentLength = 128;

        /// <summary>Split and validate a dotted path; null when it is not 2–<see cref="MaxSegments"/> plain identifiers.</summary>
        public static string[]? Split(string? dotted)
        {
            if (string.IsNullOrEmpty(dotted)) return null;
            string[] parts = dotted!.Split('.');
            if (parts.Length < MinSegments || parts.Length > MaxSegments) return null;
            foreach (string part in parts)
                if (!IsPlainIdentifier(part)) return null;
            return parts;
        }

        /// <summary>An ASCII C# identifier that is not a reserved keyword (contextual keywords are valid identifiers).</summary>
        public static bool IsPlainIdentifier(string s)
        {
            if (s.Length == 0 || s.Length > MaxSegmentLength) return false;
            char first = s[0];
            if (!(first == '_' || (first >= 'A' && first <= 'Z') || (first >= 'a' && first <= 'z'))) return false;
            foreach (char c in s)
                if (!(c == '_' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
            return SyntaxFacts.GetKeywordKind(s) == SyntaxKind.None;
        }

        /// <summary>A plain dotted type name (<c>Namespace.Type</c>) every segment of which is a plain identifier — the
        /// only enum spelling the host may write. Metadata names are not C#: a hand-made assembly can name a type
        /// <c>X.Run()</c>, which would otherwise be spliced into source as an invocation.</summary>
        public static bool IsPlainDottedName(string? name)
        {
            if (string.IsNullOrEmpty(name)) return false;
            foreach (string part in name!.Split('.'))
                if (!IsPlainIdentifier(part)) return false;
            return true;
        }

        /// <summary>The CLR property a C# access through a receiver DECLARED as <paramref name="declaredOwnerType"/> binds,
        /// provided the live <paramref name="owner"/> resolves the same name to the same slot (the same member, or an
        /// override of it). A runtime subtype that hides the member with <c>new</c> would make the canvas and the rebuilt
        /// form touch different members; null then. The returned property is the one to read and write on
        /// <paramref name="owner"/> — exactly what the compiled assignment does (virtual dispatch included).</summary>
        public static System.Reflection.PropertyInfo? SourceBoundProperty(Type declaredOwnerType, object owner, string name, bool forWrite)
        {
            var declared = BoundInstanceProperty(declaredOwnerType, name);
            var runtime = BoundInstanceProperty(owner.GetType(), name);
            if (declared == null || runtime == null || declared.PropertyType != runtime.PropertyType) return null;
            if (declared.GetGetMethod() == null || !SameSlot(declared.GetGetMethod(), runtime.GetGetMethod())) return null;
            if (forWrite && (declared.GetSetMethod() == null || !SameSlot(declared.GetSetMethod(), runtime.GetSetMethod()))) return null;
            return runtime;
        }

        private static bool SameSlot(MethodInfo? a, MethodInfo? b)
        {
            if (a == null || b == null) return false;
            MethodInfo baseA = a.GetBaseDefinition(), baseB = b.GetBaseDefinition();
            return baseA.MetadataToken == baseB.MetadataToken && baseA.Module == baseB.Module;
        }

        /// <summary>The declared type a Content hop yields, or null when <paramref name="pd"/> on <paramref name="owner"/>
        /// (whose declared type is <paramref name="declaredOwnerType"/>) is not a hop VS writes through: a reference-type
        /// property serialized as Content that C# binds, on the declared type, to the member the live object has.</summary>
        public static Type? ContentHopType(Type declaredOwnerType, object owner, PropertyDescriptor pd)
        {
            try
            {
                if (pd.PropertyType.IsValueType) return null;
                var vis = (DesignerSerializationVisibilityAttribute?)pd.Attributes[typeof(DesignerSerializationVisibilityAttribute)];
                if (vis == null || vis.Visibility != DesignerSerializationVisibility.Content) return null;
                var pi = SourceBoundProperty(declaredOwnerType, owner, pd.Name, forWrite: false);
                return pi == null || pi.PropertyType.IsValueType ? null : pi.PropertyType;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Whether a hop hands back the same live object on every read through the source-bound member. A getter
        /// that builds a fresh object (<c>=&gt; new Options()</c>) would take the edit and drop it; such a hop is refused
        /// (forwarding wrappers included — persistence cannot be proven for them).</summary>
        public static bool IsStableHop(Type declaredOwnerType, object owner, string name)
        {
            try
            {
                var pi = SourceBoundProperty(declaredOwnerType, owner, name, forWrite: false);
                if (pi == null) return false;
                object? first = pi.GetValue(owner, null);
                return first != null && ReferenceEquals(first, pi.GetValue(owner, null));
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Whether <paramref name="pd"/> on <paramref name="owner"/> (declared as
        /// <paramref name="declaredOwnerType"/>) is a leaf the host can write as a literal and a C# assignment sets.</summary>
        public static bool IsSettableLeaf(Type declaredOwnerType, object owner, PropertyDescriptor pd)
        {
            try
            {
                if (pd.IsReadOnly || !IsSimpleLeafType(pd.PropertyType)) return false;
                var pi = SourceBoundProperty(declaredOwnerType, owner, pd.Name, forWrite: true);
                return pi != null && pi.PropertyType == pd.PropertyType;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Literal-writable leaf types. Enums must be top-level, non-generic, not [Flags] and plainly named: the
        /// host writes <c>Namespace.Type.Member</c>, which a nested (<c>Outer+Inner</c>), generic or oddly-named type
        /// cannot spell, and a flags combination needs the dedicated flags editor.</summary>
        public static bool IsSimpleLeafType(Type t)
        {
            if (t.IsEnum)
                return !t.IsNested && !t.IsGenericType && IsPlainDottedName(t.FullName)
                    && !t.IsDefined(typeof(FlagsAttribute), false);
            return t == typeof(string) || t == typeof(bool) || t == typeof(char)
                || t == typeof(byte) || t == typeof(sbyte) || t == typeof(short) || t == typeof(ushort)
                || t == typeof(int) || t == typeof(uint) || t == typeof(long) || t == typeof(ulong)
                || t == typeof(float) || t == typeof(double) || t == typeof(decimal);
        }

        /// <summary>The property C# binds for <c>owner.Name</c> on a receiver of <paramref name="type"/>: the most-derived
        /// public member with that name, of ANY kind (a vendor <c>new</c> property narrows DevExpress Properties/Options;
        /// a <c>new static</c> field, method or event hides it). Null when that member is not one instance, non-indexed
        /// property.</summary>
        private static System.Reflection.PropertyInfo? BoundInstanceProperty(Type type, string name)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly;
            for (Type? cur = type; cur != null; cur = cur.BaseType)
            {
                MemberInfo[] members = cur.GetMember(name, MemberTypes.All, flags);
                if (members.Length == 0) continue;
                if (members.Length != 1 || members[0] is not System.Reflection.PropertyInfo pi) return null;
                var accessor = pi.GetGetMethod() ?? pi.GetSetMethod();
                if (accessor == null || accessor.IsStatic || pi.GetIndexParameters().Length != 0) return null;
                return pi;
            }
            return null;
        }

        /// <summary>Walk the hops of <paramref name="path"/> (all but the leaf) from <paramref name="owner"/> under the same
        /// rule describe uses, reading through the source-bound members. Returns the object that holds the leaf and its
        /// declared type, or null with a reason.</summary>
        public static object? ResolveLeafOwner(object owner, string[] path, out Type? declaredLeafOwnerType, out string reason)
        {
            reason = "";
            declaredLeafOwnerType = null;
            object current = owner;
            Type declared = owner.GetType();
            for (int i = 0; i < path.Length - 1; i++)
            {
                PropertyDescriptor? hop;
                try { hop = TypeDescriptor.GetProperties(current)[path[i]]; } catch { hop = null; }
                Type? next = hop == null ? null : ContentHopType(declared, current, hop);
                var bound = next == null ? null : SourceBoundProperty(declared, current, path[i], forWrite: false);
                if (bound == null || next == null || !IsStableHop(declared, current, path[i]))
                {
                    reason = "'" + path[i] + "' is not an editable nested object";
                    return null;
                }
                current = bound.GetValue(current, null)!;
                declared = next;
            }
            declaredLeafOwnerType = declared;
            return current;
        }
    }
}
