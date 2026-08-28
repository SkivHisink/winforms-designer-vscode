// C# init-only setters are used by compile-linked shared source. .NET Framework 4.8 does not provide this marker,
// so define the conventional compiler shim locally without changing the public runtime contract.
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit { }

    [System.AttributeUsage(System.AttributeTargets.All, Inherited = false)]
    internal sealed class RequiredMemberAttribute : System.Attribute { }

    [System.AttributeUsage(System.AttributeTargets.All, Inherited = false)]
    internal sealed class CompilerFeatureRequiredAttribute : System.Attribute
    {
        public CompilerFeatureRequiredAttribute(string featureName) { FeatureName = featureName; }
        public string FeatureName { get; }
        public bool IsOptional { get; init; }
    }
}

namespace System.Diagnostics.CodeAnalysis
{
    [System.AttributeUsage(System.AttributeTargets.Constructor, Inherited = false)]
    internal sealed class SetsRequiredMembersAttribute : System.Attribute { }
}
