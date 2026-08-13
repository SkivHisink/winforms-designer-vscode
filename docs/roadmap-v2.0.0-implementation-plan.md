# v2.0.0 implementation roadmap — Visual Studio WinForms Designer parity

**Status:** implementation blueprint; Phase 0 decisions and evidence are required before the architecture is approved for production implementation.  
**Last updated:** 2026-08-11.  
**Baseline:** repository v1.8.0, with planned 1.9–1.15 workflow milestones in [ROADMAP.md](../ROADMAP.md).  
**Target:** the Visual Studio **WinForms Designer** workflow, hosted naturally inside VS Code — not a second copy of the entire Visual Studio IDE.

This is the execution document behind the public roadmap. It turns “Visual Studio parity” into bounded behaviors, architectural contracts, ordered work, kill gates, verification evidence, and an honest release claim. A v2 feature is not complete until it is safe on source and resources, keyboard and assistive-technology accessible, measured on a representative corpus, recoverable after a worker failure, and covered on every runtime tier it claims to support.

## 1. Product contract

### 1.1 The v2 promise

v2.0.0 should let a WinForms developer perform the normal Visual Studio designer loop without opening Visual Studio:

1. create or open a Form/UserControl;
2. discover framework, project, and vendor components;
3. select, place, align, resize, reparent, order, copy, and remove components;
4. edit properties, events, collections, resources, localization, bindings, and inherited overrides;
5. use supported ControlDesigner, DesignerActionList, designer verbs, converters, and modal editors;
6. save, undo, redo, build, reopen, and round-trip through Visual Studio without silent source or resource loss;
7. diagnose an unsupported or failed design-time operation without guessing what the designer executed or changed.

The UI follows VS Code conventions, but gestures, results, keyboard reflexes, component behavior, generated-code compatibility, and failure semantics should be equivalent to the Visual Studio WinForms Designer. Where this project is already stronger — minimal source diffs, named refusal reasons, cross-runtime visibility, headless validation, and reproducible diagnostics — v2 preserves and expands that advantage.

### 1.2 What “parity” means

| Term | Required meaning |
|---|---|
| **Exact parity** | The same input produces the same component graph, persisted semantics, selection/layout result, and undo unit as Visual Studio. UI chrome may remain VS Code-native. |
| **Workflow parity** | The developer completes the same task with no extra source editing, even if the command is surfaced differently. |
| **Compatible parity** | A form round-trips between Visual Studio and this extension without semantic drift or unrelated changes. |
| **Superior workflow** | The extension adds measurable value without producing a dialect Visual Studio cannot reopen: source/resource diff preview, capability explanations, CI validation, recovery, or broader diagnostics. |
| **Unsupported** | The operation is disabled before mutation, with a stable reason code, affected target, recovery action, and support-tier link. A partial or silent imitation does not count as parity. |

The unqualified public phrase **“Visual Studio parity”** is allowed only after all GA gates in section 9 pass. Until then, release notes must name the achieved tier, for example “managed standard-control parity preview.”

### 1.3 Scope boundary: designer, not another IDE

v2 integrates with VS Code/C# tooling for code completion, semantic rename, navigation, diagnostics, build, debugging, testing, source control, and package management. It does not reimplement Roslyn, a C# editor, a debugger, Test Explorer, Git, or NuGet. Designer commands may invoke or deep-link to those existing surfaces.

The following are not part of the v2 parity claim:

- WPF, MAUI, Avalonia, web, or non-Windows visual designers;
- pixel-identical Visual Studio window chrome;
- undocumented Visual Studio/DesignToolsServer protocol compatibility or redistribution of proprietary binaries;
- arbitrary code execution made “safe” by AppDomain, ALC, or a child process — those are lifecycle boundaries, not security sandboxes;
- universal compatibility with every vendor version, licensing system, native dependency, or broken designer;
- VB WithEvents/Handles parity unless separately staffed, designed, and added to the release claim;
- Linux/macOS/WSL rendering. A Windows UI host remains required.

COM/ActiveX and x86 support are a **conditional GA scope**. They enter the unqualified parity claim only if Phase 0 bitness, hosting, redistribution, security, and packaging spikes pass. Otherwise v2 must be marketed explicitly as managed WinForms parity, while COM/ActiveX remains a named post-v2 tier.

## 2. Live baseline and constraints

The plan builds on the existing product instead of restarting it:

- [extension/src/designerEditor.ts](../extension/src/designerEditor.ts) owns the custom document (WinFormsDesignDocument, line 772), session orchestration (DesignerSession, line 1107), safe commit funnel (commit, line 1996), and full render reconciliation (fullRender, line 2621).
- [extension/src/engineClient.ts](../extension/src/engineClient.ts) contains the RPC handle and a large hand-written DTO/client surface; EngineHandle begins at line 17 and the render DTO family near line 216.
- [engine/Program.cs](../engine/Program.cs) exposes the modern RPC boundary through EngineApi at line 1446.
- [engine/DesignerRenderer.cs](../engine/DesignerRenderer.cs) is the modern render/describe/edit facade at line 59.
- [engine/DesignerControlEditor.cs](../engine/DesignerControlEditor.cs) owns source-first structural writers and independent safety gates; the current tab-order writer/gate are at lines 928 and 1096.
- [engine-net48/RenderWorker.cs](../engine-net48/RenderWorker.cs) owns interpreted and compiled-fallback runtime state; interpreted rendering begins at line 203 and the worker has both render and mutation responsibilities.
- [ADR 0001](adr/0001-net48-live-source-interpretation.md) and [ADR 0002](adr/0002-m4-edit-parity-design.md) make source authority, closed IR, runtime validation, identity/origin, and disclosed fallback load-bearing constraints.

As of this audit, the largest coordination files are approximately 7,497 lines (designerEditor.ts), 3,617 lines (DesignerRenderer.cs), 3,491 lines (RenderWorker.cs), 2,494 lines (panel.js), 2,290 lines (DesignerControlEditor.cs), 2,273 lines (engineClient.ts), and 2,229 lines (designer.js). v2 must not add a second architecture inside these files. Controlled decomposition with characterization tests is a release-enabling feature, not optional cleanup.

The 1.8–1.15 milestones remain valid and should land as small compatible releases where practical. They become input to the v2 parity corpus; v2 does not postpone every daily-workflow improvement behind the new design-time host.

## 3. Capability and parity matrix

Legend: **GA** is required for the v2 parity claim; **conditional** is required only when its Phase 0 gate passes and the claim includes that tier; **2.x** is outside v2 GA.

| ID | Capability | v2 target | Tier | Acceptance summary |
|---|---|---|---|---|
| DOC-01 | Form/UserControl open, save, Save As, hot exit, external changes | Exact | GA | No blind overwrite; dirty/undo state survives reload; concurrent disk changes refuse before mutation. |
| DOC-02 | Add Form/UserControl/component class | Workflow | GA | SDK and classic projects compile; file/project/resource creation is atomic and collision-safe. |
| DOC-03 | Partial/nested/generic/base-type resolution | Compatible | GA | Correct owning project/type; ambiguous topology is a named refusal. |
| SRF-01 | Real control rendering and hit testing | Exact | GA | Framework corpus matches runtime geometry/appearance within approved pixel tolerances. |
| SRF-02 | Select, multi-select, keyboard traversal, marquee | Exact | GA | Mouse and keyboard scenario suite; deterministic nested-container scope. |
| SRF-03 | Move, resize, reparent, z-order, copy/cut/paste/duplicate | Exact | GA | One transaction, engine-authoritative final layout, no coordinate drift. |
| LAY-01 | SnapLines/SnapToGrid/None, Alt override, grid visibility | Exact | GA | Margin/padding/baseline guides and configurable grid match reference scenarios. |
| LAY-02 | Align, size, center, spacing, anchors/dock | Exact | GA | Multi-selection commands match Visual Studio outcomes across DPI and zoom. |
| LAY-03 | Table/Flow/Split/Tab/container editing | Exact | GA | Container adapters round-trip on modern and net48 tiers. |
| PRP-01 | Categorized/alphabetical/search property grid | Workflow | GA | Multi-object intersection, mixed values, defaults/bold/reset, descriptions, keyboard navigation. |
| PRP-02 | TypeConverter, standard values, expandable values | Exact | GA | Bounded metadata and hosted converter paths; exception/cycle/latency isolation. |
| PRP-03 | Framework and vendor UITypeEditor | Compatible | GA for managed supported set | Modal/dropdown broker is cancellable, owned, DPI/theme-aware, and cannot bypass the transaction planner. |
| EVT-01 | Events tab, default event, handler generation/navigation | Exact | GA | Double-click and event grid use real metadata; source/code-behind revisions are checked together. |
| TLB-01 | Toolbox discovery/search/categories/favorites/Choose Items | Workflow | GA | Framework/project/vendor items, auto-population, cache provenance, user-curated suppression. |
| TLB-02 | COM/ActiveX toolbox and AxHost generation | Exact | Conditional | x86/x64 fixtures, license/resource generation, packaging and security gates pass. |
| OUT-01 | Document Outline and component tray | Exact | GA | Rename/reparent/order/select; nonvisual components and inherited ownership are accurate. |
| MNU-01 | MenuStrip/ToolStrip/ContextMenuStrip | Exact | GA | Direct nested edit, verbs, standard items, drag/reorder/reparent, overflow and tray paths. |
| COL-01 | Collection editors | Compatible | GA | Standard and hosted vendor collection editors plan an inspectable atomic patch. |
| RES-01 | .resx, images/icons/ImageList/project resources | Compatible | GA | Unknown/opaque nodes preserved; multi-file undo/conflict/rollback proven. |
| LOC-01 | Localizable forms, culture overlays, RTL | Exact | GA | Neutral/parent/exact fallback, ApplyResources and native RTL UX pass the matrix. |
| DAT-01 | Data Sources, binding UI, detail/grid/navigation generation | Workflow | GA | Recognized schemas produce stable BindingSource/Navigator/grid code; unsupported providers refuse. |
| INH-01 | Visual inheritance | Compatible | GA | Accessible inherited controls allow bounded derived overrides; base source is never modified implicitly. |
| EXT-01 | IDesignerHost service kernel | Compatible | GA | Documented service contract with transactions, selection, changes, names, commands, toolbox and serialization. |
| EXT-02 | ControlDesigner, adorners, verbs, DesignerActionList | Compatible | GA | Certified managed designers run in an isolated worker tier; capabilities and failures are explicit. |
| EXT-03 | Vendor adapter SDK | Superior | GA | Versioned public adapter/protocol surface, samples, compatibility tests, no product-specific hard-coded branch. |
| RUN-01 | Modern .NET runtime/architecture matrix | Compatible | GA | Project TFM/runtime selection, x64/ARM64 worker, unload/recycle and dependency isolation. |
| RUN-02 | .NET Framework runtime/bitness matrix | Compatible | GA; x86 conditional | Live-source authority retained; x64 plus gated x86 worker and deterministic fallback. |
| ACC-01 | Keyboard, screen reader, high contrast, zoom | Workflow | GA | All product operations are keyboard reachable; accessible mirror tree and manual AT evidence. |
| DIA-01 | Capability inspector and diagnostics | Superior | GA | Every unavailable operation has reason, target, recovery; export is reproducible and redacted. |
| SAF-01 | Source/resource integrity | Superior | GA | Zero silent loss/corruption; every mutation has a validated patch plan and independent postcondition. |
| AUT-01 | Headless designer validation CLI/CI | Superior | GA | Machine-readable compatibility, fallback, diff, performance, security and leak reports. |
| A11-01 | Accessibility/DPI/localization advisor | Superior | GA | Non-mutating Problems diagnostics plus opt-in, previewed quick fixes for supported rules. |
| AI-01 | Natural-language layout/repair | Integrated, optional | 2.x | Use VS Code chat/tool APIs; never a v2 safety dependency and default off until separately approved. |

### 3.1 Support tiers and claim thresholds

| Tier | Corpus | Minimum claim gate |
|---|---|---|
| **A — Microsoft framework** | Standard controls, containers, components, resources and binding patterns on supported runtimes | 100% required scenarios; zero silent fallback, corruption, crash, or unexplained semantic diff. |
| **B — custom managed controls** | In-repo FakeVendor plus independent samples using documented design-time APIs | At least 98% required scenarios; every miss classified and non-mutating. |
| **C — certified vendor suites** | Licensed, versioned cohorts from at least three materially different suites, or an explicitly smaller named set | At least 95% required scenarios per advertised cohort; zero silent mismatch/data loss; archived redacted manifest. |
| **D — COM/ActiveX/x86** | Signed/unsigned test controls, AxHost resources/licenses, AnyCPU/x86/x64 projects | 100% supported matrix if advertised; otherwise excluded by name from v2 GA. |

Percentages never waive a safety failure. One silent mutation, unexplained source loss, arbitrary-source execution, cross-document overwrite, or undisclosed stale canvas is a release blocker regardless of aggregate pass rate.

## 4. Target architecture

~~~text
VS Code extension host
  ├─ Project & document resolver
  ├─ DesignerDocumentStore (source, resx, code-behind, project baselines)
  ├─ DesignerCommandBus (intent → plan → authorize → commit → reconcile)
  ├─ Undo/resource transaction journal
  ├─ WorkerSupervisor (runtime × architecture × project × trust tier)
  ├─ generated protocol client + capability negotiation
  └─ Webview workbench
       ├─ state store / focus / keyboard / accessibility
       ├─ canvas + adorner layers
       ├─ toolbox / outline / tray
       └─ properties / events / resources / data sources / diagnostics

Versioned Designer Protocol
  ├─ control channel: bounded typed request/response/events
  ├─ render channel: sequenced frame/tile payloads
  └─ adapter SDK: versioned vendor-neutral contracts

Disposable designer workers
  ├─ Session kernel and design-time service container
  ├─ runtime adapter: modern .NET or .NET Framework
  ├─ component graph + stable identity/origin
  ├─ rendering, hit testing, layout and capture
  ├─ converters/editors/designers/verbs broker
  ├─ source-first and hosted-serialization planners
  └─ diagnostics, quotas, cancellation and deterministic teardown
~~~

### 4.1 Module boundaries

| Current concentration | Planned modules |
|---|---|
| designerEditor.ts | document, session, commands, render, transactions, resources, toolbox, localization, diagnostics |
| engineClient.ts | generated protocol DTO/client, small lifecycle client, binary render transport |
| designer.js / panel.js | typed message facade, state store, canvas, property/event grid, toolbox, outline/tray, dialogs, a11y |
| DesignerRenderer.cs | parse/IR, hosted session, render/capture, describe/metadata, capability classification |
| DesignerControlEditor.cs | command-specific planners plus shared independent postcondition gates |
| net48 RenderWorker.cs | session lifecycle, interpreted host, compiled fallback, metadata, live adapter, capture, disposal |

Characterization tests must land before moving behavior. No decomposition patch may change source output, protocol payloads, failure codes, render geometry, or undo boundaries unless its issue declares and tests the change. New hand-written coordination files should stay below roughly 1,500 lines; generated protocol code is exempt.

### 4.2 Protocol contract

Every envelope carries at least:

- protocol version and compatible range, binary build ID, and feature flags;
- session, document, request, and optional idempotent command identity;
- document revision, render generation, and source/resource fingerprints;
- deadline/cancellation identity, payload-size limits, and trace correlation;
- structured success, refusal, partial, cancelled, stale, unsupported, and fault outcomes.

The protocol uses closed, bounded DTOs. It never transports delegates, reflection objects, syntax nodes, arbitrary serialized graphs, or expression strings for a worker to execute. Unknown required fields/capabilities refuse. N and N−1 compatibility and partial-update self-repair are release tests.

### 4.3 One command model

Every mutation, whether initiated by drag, property grid, smart tag, vendor editor, quick fix, keyboard command, or automation, follows the same lifecycle:

1. capture exact document/resource/code/project revisions;
2. translate UI input to a typed designer intent;
3. resolve identity, ownership, runtime tier, and capabilities in the authoritative session;
4. produce a deterministic PatchSet plus semantic postconditions and reconciliation intent;
5. optionally preview high-impact/normalizing/vendor-generated diffs;
6. revalidate all baselines and authorize the whole set;
7. apply atomically or compensate without overwriting a concurrent external edit;
8. record one undo unit and a redacted audit event;
9. reconcile from committed state and reject stale replies;
10. independently verify the intended graph/source/resource change.

Webview messages and vendor-returned values are untrusted input. They request an intent; they cannot supply an authorized patch or bypass capability, revision, source-minimality, ownership, or resource gates.

### 4.4 Dual persistence lane

- **Lane A — minimal source adapters.** Existing byte-local Roslyn/text writers remain the default for known shapes. The current broad commit firewall remains a final guard.
- **Lane B — designer-owned region serialization.** Operations that genuinely require a hosted designer may propose a replacement only for explicitly identified generated regions/resources. The planner proves the user partial class, unrelated members, unknown statements/resources, encoding, BOM, and declared preservation zones are unchanged. Semantic equivalence and expected component-graph delta are checked independently.
- A Lane B diff above the normalization threshold requires clear preview/consent and never occurs merely by opening a form. Ambiguous ownership or equivalence refuses.
- Multi-file changes to source, resources, code-behind, or project files use a journaled exact-baseline transaction. No worker writes workspace files directly.

ADR 0001/0002 remain authoritative until Phase 0 approves **ADR 0003: v2 hosted design-time services and dual-lane persistence**. ADR 0003 must state exactly which previous non-goals it supersedes; a roadmap line alone does not weaken those decisions.

### 4.5 Hosted service kernel

The host grows by contract and corpus evidence, not by advertising a fake all-purpose service provider. Candidate milestones include real container/siting and naming; selection and component-change notifications; designer transactions and command routing; toolbox and serialization services; type resolution and property filtering; and the minimum UI broker for supported editors. For every advertised service:

- method semantics, STA/threading, lifetime, reentrancy, cancellation, and exception mapping are documented;
- a contract test proves successful and unavailable behavior;
- vendor code never receives a non-null service whose invariants are incomplete;
- design-time changes still return through the common command/patch planner.

### 4.6 Worker and trust model

Workers are disposable lifecycle boundaries selected by runtime, architecture, dependency graph, and trust tier. They run on STA with a message pump and are supervised for deadlines, memory, GDI/USER handles, crash loops, output locks, and deterministic unload/recycle.

Compiled project/vendor controls are **trusted-to-execute**: constructors, accessors, type descriptors, designers, editors, painting, and native dependencies can run arbitrary code. ALC, AppDomain, process separation, Job Objects, and quotas reduce blast radius and improve recovery; they are not a sandbox. Therefore:

- untrusted workspaces get parse-only/read-only behavior and no build, restore, assembly load, or design-time code;
- hosted vendor design-time code requires a trusted workspace plus explicit per-workspace enablement and provenance UI;
- generic source-first behavior remains available where its existing trust contract permits;
- network/filesystem restriction is claimed only if a verified OS sandbox is actually implemented;
- diagnostics distinguish refusal, dependency failure, vendor exception, timeout/crash, quota recycle, and disabled code.

## 5. Workstreams and owned deliverables

| Workstream | Deliverables | Primary areas |
|---|---|---|
| **FND — product/ground truth** | Scenario catalog, parity matrix, support tiers, ADR 0003, legal/licensing records | roadmap, ADRs, planned parity tests |
| **ARC — decomposition/protocol** | Module seams, schema source, generated clients/servers, capabilities, compatibility tests | extension, webview, planned protocol project |
| **DOC — documents/transactions** | Multi-artifact store, PatchSet, journal, undo/redo, diff preview, conflict recovery | extension document/transaction modules, engine planners |
| **HST — designer host** | Session kernel, services, designers/verbs/action lists, editor broker | planned engine Hosting modules, net48 adapter |
| **SRF — canvas/layout** | Authoritative geometry, prediction, guides/grid, selection, container adapters, smooth interaction | engine geometry/capture, webview canvas |
| **PRP — metadata/editors/events** | Multi-object grid, converters, editors, events/default handlers, collections | engine describe/editor, panel modules |
| **PRJ — project/assets/data** | Scaffolding, project resolution, resources, localization, Data Sources, settings binding | extension resolver, resource/data planners |
| **RUN — runtime/vendor** | Modern/net48 matrix, x86 conditional path, bitness/dependencies, adapter SDK, certification | engines, supervisor, fixtures |
| **QAS — quality/security/a11y** | Threat model, adversarial/parity/golden/perf/soak/a11y CI, manifests | tests, scripts, workflows, testing docs |
| **REL — migration/release** | Settings/cache/protocol migrations, packages, rollback, support matrix, evidence ledger | metadata, release workflow/docs |

Every issue names one owner, affected protocol version, source/resource risk, tests, diagnostics impact, runtime matrix, and closing gate.

## 6. Execution phases

Effort bands assume a stable core team of roughly 6–9 people: lead/architect, three C# engine/runtime engineers, two TypeScript/webview engineers, QA/test infrastructure, and part-time security, UX/a11y, release and legal/vendor support. They are planning ranges, not calendar commitments. With that team, v2 is plausibly an 18–30 month program; a single maintainer should treat near-Visual-Studio parity as multi-year and cut claims by tier rather than weaken gates.

### Phase 0 — definition and kill spikes (4–8 weeks)

- **V2-FND-001:** freeze a versioned Visual Studio catalog with traces and at least 100 core scenarios.
- **V2-FND-002:** approve ADR 0003, trust model, proprietary-binary exclusion, rollback and cut decisions.
- **V2-HST-001:** host a real Form and UserControl on the exact modern runtime using approved redistributable dependencies; inventory actual services.
- **V2-HST-002:** repeat the kernel on net48 x64; test x86/COM separately from managed GA.
- **V2-PRP-001:** prove one framework and one FakeVendor designer/action list/editor through the broker, including cancellation, reentrancy, crash, and invalid return.
- **V2-DOC-001:** produce Lane A/Lane B plans for the same forms; prove byte/semantic preservation and Visual Studio round-trip.
- **V2-SRF-001:** measure capture, preview, commit, and reconciliation on 50-, 300-, and vendor-heavy forms across the DPI matrix.
- **V2-RUN-001:** obtain licensing/redistribution/security decisions for every dependency and vendor certification path.

**Exit / kill gate:** no production implementation before managed hosting, dual-lane round-trip, worker recovery, editor broker, and legal/dependency route pass. A failed hosted serializer keeps that shape source-first. A failed vendor-host route narrows the claim. A failed x86/COM spike removes Tier D from v2 GA.

### Phase 1 — architectural runway, zero feature regression (8–14 weeks)

- **V2-ARC-001:** characterize current document, commit, render, property, resource, toolbox, tab, event, and fallback behavior.
- **V2-ARC-002:** split designerEditor.ts by document/session/command/render/transaction domains.
- **V2-ARC-003:** define protocol schema source and generate TypeScript/C# bindings.
- **V2-ARC-004:** split webview scripts into typed bundled modules with one validated message facade and central state.
- **V2-ARC-005:** split modern/net48 workers by session/render/metadata/mutation/lifecycle.
- **V2-DOC-002:** introduce document store, multi-artifact fingerprints, DesignerIntent, PatchSet, and journal behind current commands.
- **V2-RUN-002:** introduce WorkerSupervisor, capabilities, deadlines, cancellation, crash policy, worker keys, and diagnostics.
- **V2-REL-001:** add N/N−1 protocol, partial-update, settings/cache migration, rollback, and self-repair tests.

**Exit:** every v1.7 plus landed 1.x test is green with byte-identical expected output. Protocol fuzzing, stale replies, crash recovery, and transactions pass. Old coordination classes become facades or are removed; there are not two truths.

### Phase 2 — first-party Visual Studio workflow parity (12–18 weeks)

- complete keyboard selection/focus/marquee and accessible state;
- complete layout modes, grid, baseline/margin/padding snaplines, spacing, live dimensions, and authoritative reconciliation;
- complete first-party container and menu/toolstrip direct manipulation;
- ship multi-object properties, mixed values, categorized/alphabetical/search, and atomic reset/edit;
- complete default-event double-click, events parity, F7/Shift+F7, and safe refactoring integration;
- complete toolbox auto-population, provenance/cache/budgets, favorites/search, and Choose Items;
- ship atomic Form/UserControl scaffolding and SDK/classic project integration;
- complete resource picker, standard menu items, inheritance overrides, and unshipped 1.8–1.15 carry-in scope.

**Exit:** Tier A passes end-to-end on modern and net48 live-source tiers. The standard-control workflow is complete with keyboard or mouse. Cross-tool round-trip is green and unsupported shapes refuse before mutation.

### Phase 3 — hosted design-time extensibility (12–20 weeks)

- land session kernel, service registry, and contract tests incrementally;
- host framework ControlDesigner behavior, adorners, verbs, action lists, and command routing through DesignerIntent;
- land converter/editor/collection broker with ownership, DPI/theme, cancellation, timeout, and result validation;
- enable Lane B only for proven owned-region serializers; add normalization preview and independent postconditions;
- publish adapter SDK preview, sample adapters, compatibility analyzer, and version policy;
- add malicious/pathological designers, editors, converters, modal deadlocks, handle leaks, and crash-loop fixtures.

**Exit:** Tier B clears its threshold with zero silent fallback. Every service has a contract test/capability flag. Vendor code cannot write workspace files or commit outside the command bus. Disabling hosted code returns to honest generic/source-first mode.

### Phase 4 — runtime, bitness, and certified vendors (12–20 weeks)

- select modern workers by compatible TFM/runtime and x64/ARM64 architecture;
- harden net48 x64 host, dependency redirects, output release/rebuild, and live-source authority;
- implement x86/COM only if Phase 0 approved it;
- certify vendor cohorts with versioned manifests, reference results, diffs, fallbacks, timings, licenses, and environment;
- exercise dependency collisions, native DLLs, static state, multiple projects/forms, unload, crash, quota recycle, and build churn.

**Exit:** each advertised cohort clears its threshold. Package RID/PE inspection proves worker architecture. Uncertified vendors remain “best effort generic support,” never implied parity.

### Phase 5 — better than Visual Studio in targeted workflows (8–14 weeks)

- capability inspector for operation support, authority, ownership, runtime, fallback, and recovery;
- readable source/resource diff preview for high-impact, normalization, and vendor-generated edits;
- headless designer validate command with JSON/SARIF-like compatibility, security, fallback, diff, a11y, performance, and leak output;
- non-mutating accessibility, tab-order, DPI, anchoring/localization, and naming advisor with previewed quick fixes;
- reproducible redacted diagnostics: versions, capabilities, dependencies, worker events, traces, and hashes — no source, secrets, or proprietary payload by default;
- recovery timeline explaining crash/recycle/rebuild/fallback and restoring the last safe view/document state.

**Exit:** superior features are not mutation back doors. Every fix is opt-in, previewable, and undoable. Headless validation needs licensed software only for explicitly configured vendor tiers.

### Phase 6 — beta hardening (8–12 weeks)

- close extra-click, focus, shortcut, and misleading-status gaps against the reference catalog;
- independently review source/IR/protocol/resx/editor/adapter security boundaries;
- run an 8-hour multi-form soak, 500 open/edit/close cycles, crash loops, build churn, memory/handle budgets, slow/cancelled modal paths, and disk conflicts;
- complete high-contrast, 200/400% zoom, keyboard-only, NVDA, and a second screen-reader pass;
- verify all seven locales plus native culture/RTL acceptance;
- publish migration preview, compatibility report, and rollback instructions.

**Exit:** no open P0/P1 integrity, security, crash-loop, deadlock, accessibility, migration, or misleading-capability defects. Performance is measured, not hidden by broader timeouts.

### Phase 7 — RC and GA evidence (4–8 weeks)

- freeze protocol/configuration/adapter versions and support matrix;
- run clean-machine, package, minimum/current VS Code, runtime, architecture, corpus, migration, and rollback matrix from immutable artifacts;
- archive exact counts, versions, hashes, thresholds, skipped/gated legs, and vendor manifests;
- require independent code/security review and explicit maintainer product/legal/vendor GO.

**Exit:** all section 9 gates pass. Repository completion is separate from publication, vendor licensing, hardware, legal approval, and external certification.

## 7. Dependency graph and critical path

~~~text
Phase 0 decisions
  └─ Phase 1 protocol + document/command runway
       ├─ Phase 2 first-party parity ─────────────┐
       └─ Phase 3 hosted extensibility ──────────┤
             └─ Phase 4 runtime/vendor matrix ───┤
Phase 2 + Phase 3 ── Phase 5 superior workflows ┤
                                                 └─ Phase 6 beta ── Phase 7 RC/GA
~~~

Hard dependencies:

- Lane B waits for the transaction journal and independent postcondition gate.
- Vendor designers/editors wait for service contracts, trust tier, quotas, and malicious fixtures.
- x86/COM cannot delay managed parity unless Phase 0 includes it in the v2 claim.
- Data Sources generation depends on scaffolding, project resolution, resource transactions, property metadata, and atomic commands.
- Headless validation uses the same protocol/capability/command truth as the interactive product.
- GA waits for real vendor/hardware/accessibility evidence for every named tier.

## 8. Verification program

### 8.1 Required corpus

- modern .NET 8/9/10 and current target; net48 SDK/classic projects; x64/ARM64 and gated x86;
- Form, UserControl, inherited/multi-level/abstract/generic/nested/partial roots;
- standard controls, nonvisual components, all layout containers, menus, tabs, grids, trees, lists/images, binding and extenders;
- neutral/multi-culture resources, RTL, images/icons/ImageList, opaque/binary/corrupt/unsafe resources;
- same-name assemblies, version conflicts, native dependencies, vendor licensing accept/refuse paths;
- 50-, 300-, and 1,000-control stress forms, pathological TypeDescriptor graphs, crashing controls;
- forms saved by supported Visual Studio references and round-tripped back through them.

Each scenario records support tier, authority/render mode, graph, metadata, operation result, exact/normalized diff, undo/redo, diagnostics, timing, lifecycle, and reference result.

### 8.2 Test layers

1. pure source/resource planners and independent safety/postcondition gates;
2. protocol schema/compatibility/fuzz/bounds/stale/cancellation;
3. service contracts and hostile design-time components;
4. engine integration for every runtime/architecture;
5. webview interaction/focus/keyboard/accessibility;
6. Extension Host at minimum/current VS Code;
7. Visual Studio cross-tool round-trip and geometry/pixel references;
8. package/RID/PE/payload/migration/rollback;
9. performance, memory, handles, locks, crash loops, soak;
10. licensed vendor and physical hardware as explicit external legs.

### 8.3 Initial performance objectives

| Metric | Initial objective |
|---|---|
| Pointer/key input to local visual preview | p95 ≤ 16 ms on the reference workstation |
| Standard authoritative commit acknowledgement | p95 ≤ 100 ms warm; no UI-thread blocking |
| 300-control authoritative commit | p95 ≤ 250 ms warm |
| Warm standard form interactive | p95 ≤ 3 s |
| Warm 300-control/vendor form interactive | p95 ≤ 5 s or a corpus-approved bound |
| Capture/render | 30 fps authoritative plus 60 fps client overlay; stale frames never commit state |
| Idle CPU | statistically indistinguishable from baseline when idle |
| Memory/handles | bounded per worker; no positive soak leak trend; recycle before limits |
| Regression policy | more than 10% on a frozen metric requires investigation/sign-off, not a larger timeout |

Cold restore/build uses a responsiveness gate: progress within 500 ms, cancellation at every awaited stage, no editor freeze, named phase, and no assembly execution before trust/consent.

## 9. v2.0.0 GA gates

All gates are conjunctive:

1. capability matrix, support tiers, and marketing match tested artifacts;
2. Tier A is 100% on every advertised runtime/architecture;
3. every advertised Tier B/C/D clears its threshold with an archived manifest;
4. zero silent loss/corruption, unrelated change, partial transaction, or stale canvas presented as current;
5. hostile source/IR/protocol/resx produces no prohibited side effect; compiled code follows trust/consent; no fake sandbox claim;
6. representative forms survive extension → Visual Studio → extension without unexplained semantic drift;
7. N/N−1, partial update, rollback, migration, and self-repair pass;
8. soak/build churn has bounded memory/handles, no leaked output locks, deterministic recovery;
9. frozen performance budgets pass on standard, large, and vendor corpora;
10. keyboard/AT, all locales, and native RTL/culture acceptance pass;
11. clean-machine x64/ARM64 and any advertised x86/COM packages have correct architecture;
12. evidence includes exact totals, failures, skips, and gates; a timed-out aggregate is not a pass;
13. final architecture, safety, and release evidence receive independent review;
14. publication, vendor licenses, hardware, legal approval, and credentials are PASS, GATED, or NOT EXECUTED — never inferred from repository evidence.

## 10. Definition of Ready and Done

Before implementation, split phase epics into reviewable issues. An issue is **Ready** only with scenario IDs/tier, exact current symbols and owner module, protocol impact, trust/source/resource/undo/concurrency impact, runtime matrix, positive/negative/perf/a11y tests, migration/diagnostics/localization impact, dependencies, and rollback/cut behavior.

An issue is **Done** only when code, tests, support matrix, diagnostics, localization, migration, performance evidence, and independent review are complete. “Works in F5” or “matches a screenshot once” is not Done.

Suggested first order after Phase 0:

1. characterization harness;
2. protocol envelope/schema generator and compatibility tests;
3. document fingerprint and PatchSet behind current commit;
4. worker supervisor lifecycle/cancellation/crash policy;
5. split render/session/transaction code without behavior changes;
6. hosted Form/UserControl kernel behind an experimental capability flag;
7. one first-party command through the new bus;
8. one hosted verb/editor through the same bus;
9. expand corpus and services one independently releasable slice at a time.

## 11. Risk register and cut rules

| Risk | Early signal | Required control / cut |
|---|---|---|
| Proprietary dependency | No written approved distribution route | Do not ship it; use approved public contracts or narrow scope. |
| Hosted serializer rewrites user code | Lane B changes outside ownership or normalizes unexpectedly | Kill Lane B for that shape; source-first/refuse or explicit migration only. |
| Fake service compatibility | Vendor detects incomplete service semantics | Return unavailable until the full contract passes; no no-op compatibility stubs. |
| Vendor code trust | Process isolation described as sandbox | Block claim/implementation; require trusted-to-execute consent and verified OS controls. |
| Decomposition regression | Golden/protocol/source output changes during moves | Stop features, restore characterization, split smaller. |
| Cross-runtime dialect divergence | Same intent emits different source | Canonical planner persists; runtime adapters only validate/reconcile. |
| Modal deadlock/reentrancy | UI or worker hangs | Deadline/cancel/owner broker; quarantine offender; generic fallback. |
| Vendor matrix unavailable | No licenses/hardware/versioned projects | Do not claim vendor parity; ship only verified Tier A/B. |
| x86/COM destabilizes core | Phase 0 packaging/hosting/security fails | Remove Tier D; continue managed GA. |
| Performance hidden by timeouts | Frozen budgets miss | Profile/cut/disclose reduced mode; do not silently raise thresholds. |
| C# tooling varies | Optional integration absent/incompatible | Capability-detect and degrade visibly; keep core designer independent. |
| Scope exceeds capacity | Many areas remain half-built | Ship preview tiers; reduce cohorts, not integrity/security/a11y gates. |

## 12. Official reference baseline

- [Windows Forms designer differences and out-of-process model](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-differences-framework)
- [Windows Forms design-time overview and action lists](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls-design/designer-overview)
- [Designer options: grid, snaplines, rename, smart tags, toolbox](https://learn.microsoft.com/en-us/visualstudio/ide/configure-windows-forms-designer-options?view=visualstudio)
- [Designer walkthrough: layout, Outline, Properties, size/location](https://learn.microsoft.com/en-us/visualstudio/designers/walkthrough-windows-forms-designer?view=visualstudio)
- [Data-bound WinForms controls and Data Sources](https://learn.microsoft.com/en-us/visualstudio/data-tools/bind-windows-forms-controls-to-data-in-visual-studio?view=visualstudio)
- [Interactive tab-order mode](https://learn.microsoft.com/en-us/dotnet/desktop/winforms/controls/how-to-set-the-tab-order)
- [Visual Studio Toolbox behavior](https://learn.microsoft.com/en-us/visualstudio/ide/reference/toolbox?view=vs-2022)
- [Windows Forms runtime repository and design-time context](https://github.com/dotnet/winforms)
- [Visual Studio 2026 release notes](https://learn.microsoft.com/en-us/visualstudio/releases/2026/release-notes)

These sources define reference behavior, not permission to redistribute Visual Studio designer components. Licenses and product terms require a separate Phase 0 review.
