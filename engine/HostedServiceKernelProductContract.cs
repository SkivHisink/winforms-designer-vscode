using System.Collections.Generic;

namespace WinFormsDesigner.Engine
{
    /// <summary>One invariant property proposal returned by a disposable hosted-service graph. The extension still
    /// plans and authorizes the corresponding source edit independently.</summary>
    public sealed class HostedServiceKernelEdit
    {
        public string PropertyName { get; init; } = "";
        public string PropertyType { get; init; } = "";
        public string InvariantValue { get; init; } = "";
    }

    /// <summary>Cross-runtime DTO for the exact repository-certified hosted-service contract. No service, designer,
    /// delegate, component instance, or caller-authored source patch crosses the process/RPC boundary.</summary>
    public sealed class HostedServiceKernelProductResult
    {
        public bool Ok { get; init; }
        public string Status { get; init; } = "refused";
        public string ErrorCode { get; init; } = "";
        public string Reason { get; init; } = "";
        public string ComponentType { get; init; } = "";
        public string DesignerType { get; init; } = "";
        public string CertificationId { get; init; } = "";
        public string AssemblySha256 { get; init; } = "";
        public string ApartmentState { get; init; } = "";
        public List<string> Capabilities { get; init; } = new();
        public bool CompleteHostAdvertised { get; init; }
        public bool IncompleteHostWithheld { get; init; }
        public string IncompleteHostReason { get; init; } = "";
        public bool UnsupportedServiceRefused { get; init; }
        public string UnsupportedServiceReason { get; init; } = "";
        public string ActionId { get; init; } = "";
        public bool ActionInvoked { get; init; }
        public int TransactionsOpened { get; init; }
        public int TransactionsCommitted { get; init; }
        public int TransactionsCancelled { get; init; }
        public int ChangeEvents { get; init; }
        public List<HostedServiceKernelEdit> Edits { get; init; } = new();
    }
}
