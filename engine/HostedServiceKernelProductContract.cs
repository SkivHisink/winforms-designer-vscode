using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Threading;

namespace WinFormsDesigner.Engine
{
    /// <summary>The repository-certified v1 cohort reports only its original six service requirements. New Preview
    /// services have their own versioned profile; their presence must not change the exact legacy wire identity.</summary>
    internal static class HostedServiceKernelV1Contract
    {
        private static readonly string[] CertifiedCapabilities =
        {
            "ContainerSiting", "Naming", "ComponentChange", "Selection", "Transactions", "MenuCommands",
        };

        public static List<string> ProjectCapabilities(IEnumerable<string> actualCapabilities)
        {
            if (actualCapabilities == null) throw new ArgumentNullException(nameof(actualCapabilities));
            var actual = new HashSet<string>(actualCapabilities, StringComparer.Ordinal);
            // This is a projection, never a manufactured claim: a missing or differently-cased core service remains
            // missing, so the legacy consumer's exact capability firewall still refuses an incomplete result.
            return CertifiedCapabilities.Where(actual.Contains).ToList();
        }
    }

    /// <summary>Closed Preview registry entry. Service identity and method scope are contractual; an aggregate
    /// IDesignerHost alone does not prove that any particular designer API is supported.</summary>
    public sealed class HostedServiceContractDescriptor
    {
        public string Capability { get; init; } = "";
        public string ServiceType { get; init; } = "";
        public List<string> Methods { get; init; } = new();
        public string Threading { get; init; } = "Creating STA only";
        public string Lifetime { get; init; } = "Owned by one disposable kernel session";
        public string Cancellation { get; init; } = "Synchronous; caller checks cancellation before dispatch";
        public string Reentrancy { get; init; } = "No nested mutation or service construction";
        public string Refusal { get; init; } = "Unavailable service returns null and records its named capability; unsupported operations throw before mutation";
        public string Scope { get; init; } = "";
    }

    public sealed class HostedToolboxItem
    {
        public string Id { get; init; } = "";
        public string TypeName { get; init; } = "";
    }

    /// <summary>A headless framework-only toolbox. It never loads a caller-specified assembly or creates a window.
    /// Component instances remain inside the disposable worker; only catalogue DTOs may cross RPC.</summary>
    public interface IHostedToolboxCatalog
    {
        IReadOnlyList<HostedToolboxItem> GetItems(CancellationToken cancellationToken = default);
        IComponent CreateComponent(string itemId, string name, CancellationToken cancellationToken = default);
    }

    /// <summary>Explicit property-serialization lane, not a replacement for classic clipboard/CodeDOM services.
    /// Capture supports exact framework controls, at most 16 components, Text (4096 characters) and Size only.
    /// ReadProposals validates the closed data against this session and returns intents; it never mutates a graph,
    /// writes source/resources or invokes a converter, custom descriptor or serializer.</summary>
    public interface IHostedPropertySerialization
    {
        IReadOnlyList<HostedComponentPropertySnapshot> Capture(
            IReadOnlyList<IComponent> components, CancellationToken cancellationToken = default);
        IReadOnlyList<HostedComponentPropertyProposal> ReadProposals(
            IReadOnlyList<HostedComponentPropertySnapshot> snapshots, CancellationToken cancellationToken = default);
    }

    public sealed class HostedComponentPropertySnapshot
    {
        public string ComponentName { get; init; } = "";
        public string ComponentType { get; init; } = "";
        public string Text { get; init; } = "";
        public int Width { get; init; }
        public int Height { get; init; }
    }

    public sealed class HostedComponentPropertyProposal
    {
        public string ComponentName { get; init; } = "";
        public string ComponentType { get; init; } = "";
        public string PropertyName { get; init; } = "";
        public string PropertyType { get; init; } = "";
        public string InvariantValue { get; init; } = "";
    }

    public sealed class HostedServiceKernelCapabilitiesResult
    {
        public bool Ok { get; init; }
        public string Status { get; init; } = "refused";
        public string ErrorCode { get; init; } = "";
        public string Reason { get; init; } = "";
        public string ServiceProfileVersion { get; init; } = "0.1.0";
        public string ApartmentState { get; init; } = "";
        public string RootType { get; init; } = "";
        public List<HostedServiceContractDescriptor> Contracts { get; init; } = new();
        public List<HostedToolboxItem> ToolboxItems { get; init; } = new();
        public string ResolvedType { get; init; } = "";
        public List<HostedComponentPropertySnapshot> SerializedProperties { get; init; } = new();
        public List<HostedComponentPropertyProposal> Proposals { get; init; } = new();
        public bool UnsupportedClassicSerializationRefused { get; init; }
        public bool IncompleteHostWithheld { get; init; }
    }

    /// <summary>One invariant property proposal returned by a disposable hosted-service graph. The extension still
    /// plans and authorizes the corresponding source edit independently.</summary>
    public sealed class HostedServiceKernelEdit
    {
        public string PropertyName { get; init; } = "";
        public string PropertyType { get; init; } = "";
        public string InvariantValue { get; init; } = "";
    }

    /// <summary>Cross-runtime DTO for the exact repository-certified hosted-service contract. No service, designer,
    /// delegate, component instance, or caller-authored source patch crosses the process/RPC boundary. Capabilities
    /// are the exact v1 certificate requirements projected from the real session, not the newer Preview registry.</summary>
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
