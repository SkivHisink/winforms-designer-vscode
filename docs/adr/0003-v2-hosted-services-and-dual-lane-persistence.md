# ADR 0003 — v2 hosted design-time services and dual-lane persistence

- **Status:** accepted for repository-side managed implementation (2026-08-19); external legal, vendor,
  hardware, accessibility, and publication approvals remain **GATED**.
- **Scope:** the managed v2 architecture and its safety boundary. This ADR does not authorize a public GA claim.
- **Deciders:** maintainer-requested repository closeout, grounded in the Phase 0 implementation roadmap, the live
  engine/package manifests, and the official Microsoft references listed below.

## Context

The current engines already use public WinForms design-time contracts on disposable render surfaces, but they do not
yet expose a complete, versioned service kernel or a single multi-artifact command/transaction model. v2 needs bounded
`ControlDesigner`, action-list, verb, converter, and editor support without pretending that process/AppDomain/ALC
isolation is a security sandbox or importing Visual Studio's proprietary designer server.

The existing source-first writers and byte-local commit firewall are proven preservation mechanisms. Replacing them
wholesale with hosted serialization would increase normalization and unrelated-diff risk. Conversely, some documented
design-time behavior cannot be reproduced truthfully without real services and an owned serializer region.

## Decision

1. **Managed-only GA baseline.** The v2.0.0 GA scope is Microsoft framework controls and supported custom managed
   controls on modern `win-x64` / `win-arm64`, plus the documented .NET Framework 4.8 x64 compatibility payload.
   Tier D (`x86`, `COM`, and `ActiveX`) is excluded by name from v2.0.0 GA. Unsupported Tier D requests fail before
   mutation with stable diagnostics such as `X86_WORKER_UNAVAILABLE` or `COM_ACTIVE_X_UNSUPPORTED`.
2. **No proprietary Visual Studio binaries.** Shipping code may use public .NET/WinForms contracts and dependencies
   whose redistribution route is recorded and approved. It must not redistribute or depend at runtime on undocumented
   Visual Studio/DesignToolsServer protocols or Visual Studio binaries outside an explicit applicable REDIST grant.
3. **Real services, never compatibility stubs.** The hosted kernel advertises a service only after its threading,
   lifetime, transaction, notification, cancellation, reentrancy, and failure semantics have contract tests. An
   incomplete service is unavailable (`null`/named capability refusal), not a no-op imitation.
4. **Trusted-to-execute model.** Loading a project/vendor assembly, constructor, property descriptor, converter,
   designer, action list, editor, native dependency, or paint path can execute arbitrary code. It requires a trusted
   workspace and explicit per-workspace hosted-code enablement. Worker isolation, quotas, Job Objects, ALC/AppDomain,
   deadlines, and recycle improve lifecycle/recovery; they are not described as a sandbox.
5. **One command authority.** Hosted code cannot write workspace files. It returns a bounded intent/result to the
   command planner, which captures exact baselines, constructs an inspectable `PatchSet`, revalidates every artifact,
   commits atomically or compensates, records one undo unit, reconciles, and checks an independent postcondition.
6. **Dual persistence lane.** Lane A remains the default: minimal source/resource adapters for known shapes. Lane B is
   allowed only for a proven designer-owned region/resource, with exact ownership, baseline, preservation,
   normalization-preview, rollback, and semantic-delta gates. A shape that fails those gates stays Lane A or is named
   unsupported; opening a form never normalizes it.
7. **Protocol and recovery are release contracts.** Closed bounded DTOs, capability negotiation, N/N-1 compatibility,
   stale/cancelled outcomes, partial-update self-repair, crash-loop quarantine, and deterministic worker replacement
   are required before a hosted feature can enter the GA matrix.

## Exact relationship to ADR 0001 and ADR 0002

This ADR supersedes only these earlier scope statements:

- ADR 0001 lines 16–17 and 64–68: “vendor design-time hosting remains a permanent non-goal” becomes “hosted managed
  design-time behavior is allowed only through public contracts, the trusted-to-execute opt-in, and certified service
  capabilities; Visual Studio's private SDK/server and proprietary binary redistribution remain out of scope.”
- ADR 0001 lines 147–153: “no general fake `IDesignerHost`” remains true for the closed-IR interpreter, while a separate
  v2 hosted worker may expose a real, incrementally certified service kernel. It must not return a non-null incomplete
  service.
- ADR 0001 lines 240–246: vendor designers/action lists/UITypeEditors move from unconditional exclusion to the
  conditional hosted managed tier above. The existing compiled-code trust disclosure, source allowlists, resource
  refusals, and fallback honesty remain authoritative.

ADR 0002 remains authoritative for source authority, canvas identity, revision/token publication gates, interpreted
request lifetime, stale/failure behavior, and source-first reconciliation. Hosted Lane B does not create a second write
authority and cannot bypass those rules.

## Phase 0 cut and rollback rules

- A hosted serializer that changes outside its declared owned region, loses opaque resource nodes, or cannot prove the
  expected graph delta is killed for that shape; Lane A/refusal remains.
- A vendor host that cannot meet service, cancellation, reentrancy, crash, provenance, and result-validation contracts
  is excluded from the advertised tier; generic/source-first support may remain.
- x86/COM/ActiveX is already removed from v2.0.0 GA. A future 2.x spike must independently pass packaging, security,
  licensing, recovery, and physical-hardware gates before any Tier D claim is advertised.
- An unavailable redistribution/license approval prevents packaging that dependency even when the technical spike
  passes.
- Disablement or rollback of hosted code must leave the current generic/source-first designer and documents usable.

## Current evidence and unresolved gates

The repository currently targets `net10.0-windows` for the modern engine and `net48` x64 for the framework engine, using
public NuGet dependencies (`Microsoft.CodeAnalysis.CSharp`, `StreamJsonRpc`). It packages separate win-x64/win-arm64
modern payloads and an x64 net48 compatibility payload. This is sufficient to approve the repository-side managed
boundary, not to infer legal or hardware approval.

`V2-HST-002` is a feasibility result only for net48 x64 compatibility. It does not mark the broader hosted kernel,
WorkerSupervisor, designer-service contracts, or x86/COM/ActiveX implementation complete.

`V2-RUN-001` is **repo-side approved for the managed baseline** above. Dependency-license review, vendor agreements
and certification, x64/ARM64 physical validation, legal/product approval, publication credentials, public rollout, and
any future Tier D decision remain **GATED** or **NOT EXECUTED**. No repository test can turn those external gates into
PASS.

## Official references

- [Target frameworks in SDK-style projects](https://learn.microsoft.com/en-us/dotnet/standard/frameworks)
- [Windows Forms designer differences and the out-of-process model](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-differences-framework)
- [Windows Forms design-time overview](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-overview)
- [Troubleshoot 32-bit components in the Windows Forms Designer](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/visualstudio/troubleshoot-32bit)
- [Visual Studio 2026 redistribution](https://learn.microsoft.com/en-us/visualstudio/releases/2026/redistribution)
- [Visual Studio 2022 redistribution](https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution)
- [Determine which Visual C++ files may be redistributed](https://learn.microsoft.com/en-us/cpp/windows/determining-which-dlls-to-redistribute?view=msvc-170)
