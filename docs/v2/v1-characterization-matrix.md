# V2-ARC-001 v1 behavior characterization matrix

Date: 2026-08-20

Status: repository contract frozen; current full-suite result is recorded in
[`../release-2.0.0-gate-record.md`](../release-2.0.0-gate-record.md).

This matrix is the regression boundary for the v2 architecture runway. It does not assert Visual Studio reference
parity, physical hardware acceptance, licensed-vendor certification, or publication readiness. It names the observable
v1 behavior that v2 must preserve while large coordination files are decomposed and mutation paths are moved behind the
generated protocol, document store, PatchSet transaction, and worker-supervision boundaries.

## Frozen behavior contracts

| Domain | Observable contract that must not regress | Primary implementation seam | Automated characterization |
| --- | --- | --- | --- |
| Document identity and save | Work is tied to the exact source/resource/project bytes that were captured. External changes, ambiguous ownership, unsafe names, duplicate targets, and destination collisions refuse before mutation. Save does not manufacture unrelated diffs. | `extension/src/designerEditor.ts`, `extension/src/formSiblings.ts`, `extension/src/atomicFile.ts`, `engine/SaveSafety.cs` | `extension/src/documentStore.test.ts`, `extension/src/formSiblings.test.ts`, `extension/src/atomicFile.test.ts`, `tests/Engine.UnitTests/SaveSafetyTests.cs`, named-pipe E2E |
| Commit and undo | A logical edit either commits its complete intended file set as one undo unit or compensates only bytes written by that edit. A stale or ambiguous state is surfaced for recovery and never overwritten. | `extension/src/resourceTransaction.ts`, `extension/src/transactionRunner.ts`, resource commit facade in `extension/src/designerEditor.ts` | `extension/src/resourceTransaction.test.ts`, `extension/src/transactionRunner.test.ts`, `extension/src/transactionIntegration.test.ts` |
| Render authority and fallback | Current source is authoritative. Interpreted rendering is used only for fully represented input; unsupported or failed execution has a stable named compiled-fallback or refusal reason. No partial preview is advertised as complete. | `engine/DesignerRenderer.cs`, `engine/DesignerIrBuilder.cs`, `engine/DesignerIrExecutor.cs`, `engine/RenderModeDecision.cs`, `engine-net48/RenderWorker.cs` | `tests/Engine.UnitTests/InterpretedRenderPlanTests.cs`, `tests/Engine.UnitTests/RenderModeClassifierTests.cs`, `tests/Engine.UnitTests/CoverageGateTests.cs`, named-pipe E2E |
| Geometry, selection, and layout | The engine remains authoritative after optimistic webview interaction. Selection has a stable primary item, nested-container scope, and current render generation. Managed layout containers refuse raw bounds edits unless a bounded container planner owns the change. | `extension/media/designer.js`, `extension/src/designerEditor.ts`, `engine/DesignerGeometry.cs`, `engine/DesignerLayout.cs` | `extension/src/webview-e2e.ts`, `tests/Engine.UnitTests/DesignerGeometryTests.cs`, named-pipe E2E |
| Properties and editors | Property targets are closed, typed, and revision-checked. Multi-selection exposes only the safe intersection, mixed values stay explicit, reset removes only owned assignments, and editor/converter results are bounded before commit. | `extension/src/multiProperty.ts`, `extension/media/panel.js`, `engine/DesignerDescribe.cs`, bounded engine editor modules | `extension/src/multiProperty.test.ts`, property sections of `extension/src/webview-e2e.ts`, `tests/Engine.UnitTests/DesignerMultiPropertyTests.cs`, editor/converter unit tests |
| Resources and localization | Neutral and culture-specific resources preserve opaque nodes and fallback semantics. Source plus `.resx` changes are one transaction; stale resource bytes refuse. Binary or unsafe expressions remain visibly unsupported. | `extension/src/projectResources.ts`, resource commit facade in `extension/src/designerEditor.ts`, engine resource/localization editors | `extension/src/projectResources.test.ts`, `tests/Engine.UnitTests/DesignerProjectResourcePickerTests.cs`, `tests/Engine.UnitTests/DesignerResxLocalizationTests.cs`, localized-resx unit tests, named-pipe E2E |
| Toolbox and project controls | Framework/project controls are discovered with provenance and bounded caches. Untrusted/out-of-scope assemblies refuse; Choose Items does not imply COM/ActiveX support. User interaction preempts background discovery. | `extension/src/toolboxDiscovery.ts`, `extension/src/designerEditor.ts`, `engine/Program.cs`, `engine-net48/Program.cs` | `extension/src/toolboxDiscovery.test.ts`, toolbox sections of `extension/src/webview-e2e.ts`, `tests/Engine.Net48.UnitTests/ToolboxAssemblyScannerTests.cs`, named-pipe E2E |
| Tabs, menus, collections, and outline | Collection order and containment are persisted through bounded source planners, not inferred from pixels. Missing targets, containment cycles, anonymous items, and unowned collection shapes refuse without a partial edit. | `extension/src/tabViewState.ts`, `extension/media/designer.js`, `engine/DesignerControlEditor.cs`, bounded collection/menu editors | `extension/src/tabViewState.test.ts`, menu/outline sections of `extension/src/webview-e2e.ts`, `tests/Engine.UnitTests/TabPageReorderTests.cs`, collection/editor unit tests, named-pipe E2E |
| Events and navigation | Default-event creation, existing-handler selection, F7/Shift+F7 navigation, and rename operate against current code-behind identity. Stale code-behind refuses rather than duplicating or overwriting a handler. | `extension/src/designerEditor.ts`, `engine/DesignerControlEditor.cs`, webview gesture facade | event/navigation sections of `extension/src/webview-e2e.ts`, named-pipe E2E, Extension Host smoke |
| Inheritance | Inherited controls remain visible. Only explicitly supported accessible properties can produce a derived assignment; private/locked geometry and ambiguous inherited identity refuse. Derived-only controls remain editable. | `engine/DesignerInheritedOverrideEditor.cs`, `engine-net48/DesignerInheritedOverrideEditorBridge.cs`, ownership gates in geometry/editor paths | modern and net48 inherited-ownership/override tests, named-pipe E2E |
| Engine lifecycle and recovery | Builds release output locks, engine loss advances generation, late replies cannot win, retries are bounded, and crash-loop/quarantine state is diagnostic. Runtime/architecture/trust selection happens before worker startup. | `extension/src/engineClient.ts`, `extension/src/engineRecovery.ts`, `extension/src/externalBuild.ts`, `extension/src/workerSelection.ts`, `extension/src/workerSupervisor.ts` | lifecycle/recovery Vitest suites, modern/net48 named-pipe E2E, Extension Host smoke |
| Diagnostics and capability truth | Unavailable, fallback, stale, gated, and not-executed states retain stable reasons. Diagnostics disclose versions, timings, identities, and hashes but not source, secret-like values, or proprietary payloads by default. | `extension/src/extension.ts`, `extension/src/v2HeadlessValidate.ts`, protocol outcome/refusal contracts | `extension/src/engineClient.test.ts`, `extension/src/v2HeadlessValidate.test.ts`, Extension Host diagnostics smoke |

## Required verification layers

The characterization boundary is conjunctive. A release record may call it green only when every applicable layer below
has a terminal PASS result from the same stabilized worktree or immutable package pair:

1. Generated v2 protocol drift check.
2. Modern and net48 engine unit suites.
3. Extension Vitest suite, TypeScript typecheck, and production build.
4. Live-webview suite against the real `media/designer.js` and `media/panel.js`.
5. Named-pipe E2E with net48 required rather than skipped.
6. Localization parity and mojibake scans for all shipped locales.
7. Security coverage gate, package audit, and performance baseline.
8. VS Code Extension Host smoke at the declared minimum and current supported VS Code versions.
9. x64 and ARM64 VSIX isolation assertions from separately frozen artifacts.

Manual or external legs are recorded independently. A missing Visual Studio trace, physical ARM64/DPI device,
screen-reader session, licensed-vendor artifact, legal approval, or publication credential never converts an internal
test result into a global PASS.

## Change-control rule

During Phase 1, an extracted module is accepted only when its caller becomes a facade over one authoritative
implementation and the relevant characterization layer remains green. Keeping a legacy mutation implementation beside a
new transaction or protocol implementation is a temporary integration state, not an exit condition. If byte output or a
stable refusal reason must change for v2, the change needs an explicit migration/compatibility entry and new evidence;
silently updating a golden expectation is not sufficient.
