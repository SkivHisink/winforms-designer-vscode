using System;
using System.Linq;

namespace WinFormsDesigner.Engine.Net48
{
    /// <summary>
    /// Assembly-version-independent identity used by the current-source/compiled-base stale-build handshake.
    /// <see cref="Type.FullName"/> is sufficient for a non-generic base, but a constructed generic includes
    /// assembly-qualified arguments while Roslyn's old resolver returned only the open generic definition. This
    /// canonical form keeps the reflection metadata name and every concrete argument without binding the comparison
    /// to an assembly version: <c>N.Base`1[System.Int32]</c>.
    /// </summary>
    internal static class RuntimeTypeIdentity
    {
        public static string Of(Type type)
        {
            if (type == null) return "";
            if (type.IsGenericParameter)
                return (type.DeclaringMethod == null ? "!" : "!!") + type.GenericParameterPosition;
            if (type.IsArray)
                return Of(type.GetElementType()!) + "[" + new string(',', type.GetArrayRank() - 1) + "]";
            if (type.IsByRef) return Of(type.GetElementType()!) + "&";
            if (type.IsPointer) return Of(type.GetElementType()!) + "*";

            Type definition = type.IsGenericType ? type.GetGenericTypeDefinition() : type;
            string name = definition.FullName ?? definition.Name;
            if (!type.IsGenericType) return name;

            return name + "[" + string.Join(",", type.GetGenericArguments().Select(Of)) + "]";
        }
    }
}
