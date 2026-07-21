// C# init-only setters are used by compile-linked shared source. .NET Framework 4.8 does not provide this marker,
// so define the conventional compiler shim locally without changing the public runtime contract.
namespace System.Runtime.CompilerServices
{
    internal static class IsExternalInit { }
}
