# Release 2.2.0: product protocol and worker lifecycle

Date: 2026-10-05  
Status: **ACCEPTED LOCALLY — every check of the CI definition passed on the final tree; publication pending**

This release implements [R22-01 through R22-08](roadmap-2.0.0-to-3.0.0.md#milestones).
The starting checkout was clean at `18a01c096502039ea913a1e8cc2ad0d320837e35`, version 2.1.0.

## Implementation plan

- [x] Characterize the existing ordinary render/edit/save paths and preserve their source and native-history guards.
- [x] Negotiate the actual engine build and route product traffic through versioned request envelopes.
- [x] Connect stable operation identity and commit reconciliation to the host's existing document and journal authority.
- [x] Move product process ownership into a bounded supervisor with project graph identity, independent startup consumers and crash/recycle generations.
- [x] Run direct modern/net48 product acceptance, the CI checks and both package assertions on the final product tree.
- [x] Bind retained reports to source and binary hashes, record limitations, and update the release verdict.

## Acceptance ledger

| Task | Required outcome | Status |
|---|---|---|
| R22-01 | Existing DTO, geometry, minimal source edits and native Undo retain their behavior | PASS — HOST-001…004 on both routes; Visual Studio reference comparison; engine and webview suites |
| R22-02 | Real extension/engine range, capabilities and binary identity negotiation | PASS — `engineTransport.test.ts`; every host run negotiates the hashed engines it records |
| R22-03 | Product render, describe and selection requests carry document/revision/generation/deadline identity | PASS — HOST-009, HOST-010; generation guard on tab and strip-item clicks (webview suite) |
| R22-04 | Stable mutation operation identity, payload fingerprint and sole host commit outcome | PASS — HOST-008 and HOST-013 on both routes; `mutationOperation.test.ts` |
| R22-05 | Product supervisor owns ordinary worker startup, reuse, release and recovery | PASS — HOST-005, HOST-006 (modern and net48), HOST-011 |
| R22-06 | Incompatible project/configuration/runtime/dependency graphs are isolated with bounded residence | PASS — HOST-007 on both routes |
| R22-07 | Bounded queues, payloads, deadlines and process resource growth | PASS — `workerSupervisor.test.ts`, `engineTransport.test.ts` (unit level; see limits) |
| R22-08 | Partial installation, late replies, cancellation and crash loops fail closed without discarding dirty data | PASS — HOST-010, HOST-012 and HOST-014 on both routes; installed upgrade/downgrade; missing payload in the headless suite |

## Verification

All results were produced on 2026-10-07 from the final tree, on the working tree over `d1bc578`, which the
machine reports record as dirty. A release commit that adds exactly that tree needs no new evidence; any further
product change does. The engines embed the commit id in their product version, so the same sources built from
the release commit carry different engine hashes from the ones recorded here; the extension bundle does not. The
release preflight ran in metadata-only mode: clean-tree and tag identity are checked on the CI checkout. A passing
diagnostic probe or unit helper is not recorded as product acceptance.

- Engine suites: **704/704** (modern) and **64/64** (.NET Framework), including the nested-property, decimal,
  string-concatenation, native-image preflight and process-containment checks.
- Extension unit/integration layer: **639/639** tests (146 suites), including rollback preparation, admission,
  recovery policy, supervisor bounds and diagnostics.
- Headless webview suite: **997 checks across 214 tests**, 0 failed. Headless end-to-end suite with the
  .NET Framework legs required: PASS.
- Archived Visual Studio reference renders, the 80 % coverage gate, the static scenario catalogue and the generated
  protocol check: PASS.
- Strict localization parity: **578 runtime keys / 44 package keys** in every locale. Mojibake scan: **830** files.
- Real Extension Host smoke on VS Code **1.84.0**: **18/18** in two of three runs, including S104, S124, and the
  S016 first-form and S122 first-use and steady-state budgets described below; the third missed the 60 s wait for
  S082's first render, with no recorded failure. On Stable **1.140.0**: **17/18**; the one miss was S122's first
  edit of the .NET Framework form (890 ms against 750 ms), which found its 10 s interpreted graph expired and
  re-interpreted the 300-control form, because the edits before it ran slowly while other workloads shared the
  machine. The measured scenario catalogue and the adversarial evidence controls were therefore not run on this
  tree; the CI run is the binding result.
- Ordinary product acceptance (`release22:extension-host`): **28/28** on each version, exit 0 —
  [1.84.0](release-2.2.0/host-1.84.0.json), [1.140.0](release-2.2.0/host-1.140.0.json). Both record the same
  extension bundle (`79251679…2312`), suite (`bd885c56…8f98`), modern engine (`8df73287…7c9c`) and .NET
  Framework engine (`003e8a71…e031`).
- Installed 2.1.0 → 2.2.0 → 2.1.0 on VS Code 1.84.0 and 1.140.0: **PASS**, three normal workbench phases and nine
  persistence/recovery checks each — [1.84.0](release-2.2.0/upgrade-downgrade-1.84.0.json),
  [1.140.0](release-2.2.0/upgrade-downgrade-1.140.0.json). The installed package is the frozen x64 VSIX below.
- Windows x64 and ARM64 VSIX creation, `scripts/assert-vsix.ps1` and the packaging isolation tests: **PASS**
  ([packages](release-2.2.0/packages.json)). Both packages carry the same extension bundle and .NET Framework engine,
  and the extension bundle equals the one the product acceptance ran.

The retained reports replace local temporary directories with `<ci-temp>`; nothing else in them was changed.

### Cost of per-project workers

Workers are isolated per project graph (R22-06), so the first form of a project starts its own worker instead of
reusing one already warm from another project. Measured on the same machine against 2.1.0: the first render of the
dense 300-control form takes about 3.5–4.4 s instead of 2.2 s, and the first three property edits planned by a
fresh worker take up to about 400 ms instead of 30–60 ms while tiered compilation promotes the edit path; later
edits return to 2.1.0 levels. The acceptance budgets name this explicitly: S016 (the first form of each project)
allows 6.5 s to an interactive canvas and 1 s for its first commit, S122 checks a fresh worker's first three
edits against 750 ms and keeps the unchanged steady-state phase budgets for every edit after them.

### Found and fixed during acceptance

- An accepted High-DPI quick fix, or another committed property edit, no longer reports a failure when a newer
  render overtakes its canvas refresh; the form is redrawn from the current source instead.
- Each accepted frame starts a background toolbox refresh, and every request context hashes the project's output
  dependencies synchronously. The refresh was started inside a redundant product scope before entering its own
  background scope, so the identity was captured twice: about 15–25 ms per full render against 6–9 ms for the frame
  itself on the 300-control form, which put S122's 32 ms preview budget out of reach. It now enters its background
  scope directly; the 300-control frame measures 20–27 ms. Starting the refresh after the frame instead was tried
  and withdrawn: the background work then outlived the render's hold on its worker and delayed the next form's
  first render and first edit.
- The first Stable run of the ordinary product acceptance missed one native Undo in HOST-002 and passed on the
  rerun; the final run passed on both versions without retries.
- The idle-recycle and crash-recovery scenarios (S104, S124, HOST-005, HOST-010, HOST-014) told a fresh worker from
  an exited one by process id. Windows reuses process ids, and a shared runner gave a fresh worker the number of
  one that had already exited. They now identify a worker by its transport session, which is new for every
  started process.

## Product contract

The ordinary designer RPC path now enters `engineTransport.ts` through `startEngine`, with process ownership in
`workerSupervisor.ts` and project residence in `engineRegistry.ts`. Existing engine methods still produce the
same DTOs and targeted source proposals. The shared `RuntimeProtocol.cs` dispatches only the explicit method
registry; the existing identifier, interpreter and edit-minimality gates remain authoritative.

Negotiation separates wire version 2 from extension SemVer 2.2.0. Both peers check the protocol intersection,
required capabilities, schema fingerprint, runtime, architecture and the SHA-256 of the actual selected engine
assembly. Ordinary requests carry session, document, request, revision, generation, source fingerprint, deadline
and cancellation identity. A stale or cancelled response does not publish a result. Negotiation, cancellation
and process-health queries use the control channel rather than source RPC payloads.

UI mutations carry a stable operation ID and a separate delivery-attempt ID. `HostMutationLedger` publishes its
pending record before effects and records the sole host outcome. Repeating the same intent returns that outcome
without another source diff or native Undo entry; a different payload under the same ID is refused. Child engine
proposals include method, payload and captured source/revision in their command identity. The engine's proposal
cache is transient; the durable host ledger owns the commit decision.

Operation records have no automatic expiry. Revision changes, native Undo, document close and process restart
do not end their retry boundary. Clearing extension storage ends it, and callers must abandon the old IDs.
Native history closures remain session-local. Pending companion buffers or vendor callbacks whose outcome is
unproven require explicit reconciliation; an unknown callback is not automatically repeated.

Worker identity includes owner project, selected configuration/TFM/platform, runtime, architecture, dependency
bytes and workspace trust policy. Content fingerprints are bounded and do not trust file timestamps alone.
Incomplete or unhashable dependency evidence receives a fresh opaque identity instead of warm graph reuse.
The resident-worker setting is 4 by default, with range 1–16; busy workers are not evicted. Each .NET Framework
worker owns a thin launcher and its isolated render child, so the setting counts worker groups rather than
individual OS processes. The existing separately bounded hosted-editor processes retain their own lifecycle.

A designer request retains workers across host preparation between RPCs, including modern-converter/net48-authority
pairs. Completed temporary resolvers and individual reflection scans release their own leases before the next
phase. Idle eviction requires both zero pending
RPCs and zero workflow leases. Completion, failure and document cancellation release those leases; explicit
stop, rebuild, process crash and supervisor limits retain the authority to stop the worker.

## Limits and failure boundaries

| Boundary | Implementation |
|---|---|
| Supervisor pending queue | 32 requests; overload is an explicit refusal |
| Resident-worker admission | 32 waiting acquisitions, at most 8 seconds, with document cancellation; no RPC replay |
| Ordinary request deadline | 30 seconds |
| Engine startup / negotiation | 15 seconds / 10 seconds |
| Request payload / handshake | 1 MiB / 16 KiB |
| Serialized outer envelope | 2 MiB + 32 KiB |
| Engine pending requests / retained document states | 64 / 1,024; document-state overflow is refused until recycling |
| Transient proposal outcomes | Newest 256 within 16 MiB |
| Retained cancellation tokens | 256 |
| Worker working set / handles | 1 GiB / 8,192 absolute, plus 2,048 growth from baseline |
| Active process sampling | Once per second; health query has a 2-second bound |
| Dependency fingerprint | 256 files, 16 MiB per file, 64 MiB total, 100 ms cooperative time budget |
| Restored-source receipt reconciliation | 4,096 records, 1 MiB per record, 16 MiB total, 1 second cooperative time budget; excess requires manual recovery |

Process resource budgets measure the process serving RPCs: the modern worker or net48 render child. The net48
launcher's additional working set is not included in that sampled usage. These are supervisor limits, not OS
allocation caps. The payload limit bounds
requests; response DTOs have no matching byte cap. Synchronous STA/vendor code cannot be safely preempted inside
the engine. Late results are suppressed, and supervisor deadlines or cancellation grace can recycle the process.
The cooperative dependency time budget cannot interrupt a blocked synchronous filesystem call.

An opaque dependency graph intentionally loses warm reuse between captures. The small fixture timings do not
establish latency parity for large or unreadable vendor graphs. A package for ARM64 proves its PE/RID contents;
it does not prove physical ARM64 execution of either engine.

Operation/journal writes flush staging bytes before publication. The evidence is for process crashes; Node's
Windows directory-handle limitations do not justify a power-loss durability claim. Resource/source reconciliation
must use the actual restored document or durable source baseline, never the mere registration of native Undo.

Installation faults have the localized `ENGINE_INSTALLATION_INCOMPATIBLE` recovery instruction: preserve dirty
documents, reinstall a matching extension payload and reload the window. A restart action that cannot repair the
installation is not offered as its remedy. Form Status offers that reinstall as its only action.

After three crashes of one runtime within 30 seconds automatic recovery stops, restarts still waiting on their
back-off are cancelled, and the form keeps its unsaved source. An explicit restart starts a fresh budget. Both
engines hold themselves in a kill-on-close job before serving, so helper processes and processes started by
design-time code end with the engine; an engine that cannot establish this does not serve.

## Reproducible acceptance

```powershell
dotnet build engine -c Release
dotnet build engine-net48 -c Release -p:PlatformTarget=x64
dotnet test tests/Engine.UnitTests -c Release
dotnet test tests/Engine.Net48.UnitTests -c Release
cd extension
npm ci
npm run typecheck
npm test
npm run build
npm run release22:extension-host -- --version=1.84.0
npm run release22:extension-host -- --version=stable
npm run release22:upgrade -- --version=1.84.0 --baseline=18a01c096502039ea913a1e8cc2ad0d320837e35
npm run release22:upgrade -- --version=1.140.0 --baseline=18a01c096502039ea913a1e8cc2ad0d320837e35
```

The ordinary-product runner creates modern and net48 projects with distinct dependency graphs. It drives real
render/describe, property, geometry, structural, event and resource edits; native Undo/Redo; save; coordinated
build; actual worker crashes; repeated operation IDs; stale generations; reordered responses; cancellation and
resource-journal interleavings. Its report is accepted only when all required scenarios pass and the tested engine
and extension hashes remain unchanged throughout the run.

The installed runner reconstructs the exact repository 2.1.0 baseline and installs real VSIX packages into
isolated profiles. It requires an explicit cached VS Code version; 1.140.0 is the Stable distribution used for
this release's local acceptance. Normal workbench processes preserve actual SQLite state and CustomDocument backups.
Before the Extension Host restart/downgrade the product's **Prepare Rollback** command freezes new edits, waits for
running operations, refuses while an operation or transaction journal of this version is undecided, and stops the
workers while still frozen; no replacement worker may start afterwards. Records written under another schema are
preserved untouched and do not block the switch. Installed 2.1.0 then restores the dirty backup and exercises
native Undo/Redo.
The reconstructed old package is not an attestation of a historical Marketplace package's byte identity.

Both acceptance harnesses and their maps are excluded from the VSIX and checked by the packaging isolation gate.

## Preparing a rollback

**WinForms: Prepare to Roll Back or Downgrade the Designer** stops admitting new designer operations, waits up to
30 seconds for running ones, then reads the operation records and transaction journals. It refuses, and the current
version keeps working, while an operation of this version is pending or a journal still needs recovery, while a
record cannot be read or the scan exceeds its bound, while a worker does not confirm its exit, or while auto-save
would still write an open file. An operation recorded as undecided needs explicit consent. Records written under
another schema are preserved and do not block. Saves, scaffold commands, document opening and open-time
reconciliation are held to the same admission. Native Undo, Redo and Revert cannot be refused once VS Code has moved
its own model, so during a prepared rollback they run and cancel the preparation, which must then be repeated. Only
one preparation runs at a time, and a Resume action offered by an older one no longer applies.

## Limits of this evidence

- Partial updates and quota pressure are proven at the transport, supervisor and headless levels (missing payload,
  identity mismatch, bounded queues, payloads, deadlines and usage queries), not by corrupting an installed package.
- After a failed native Undo re-marks a form as unsaved, a later successful **Save As** leaves the workbench's own
  dirty marker on the original editor, so closing it asks once more. No source is lost.
- The test-only `source-map-js` override moves to 1.2.2 for a new advisory against 1.2.1 (a transitive
  dependency of `jsdom` and `vite`, not part of the packaged extension).
- The S122 budgets judge each corpus and DPI leg by a single sample, so one slow frame fails the scenario. The
  first edit of the .NET Framework form stays within its first-use budget only while the interpreted graph from
  its last render is still inside the interpreter's 10 s safety window; on a machine slow enough to exceed that
  window it re-interprets the whole form. The budgets were not changed; the release CI run is the binding S122
  result.
- The 2.1.0 package is reconstructed from its release commit. Physical ARM64 execution, power-loss durability and
  other operating systems are not covered.

## Release boundary

Public distribution, physical ARM64/DPI acceptance, licensed-vendor certification and broader Visual Studio
parity retain their separate evidence requirements. The historical 2.0 and 2.1 evidence is not rewritten.
