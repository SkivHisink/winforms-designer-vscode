# Project map

Where things live and how they connect. For the build/test loop see [CONTRIBUTING.md](../CONTRIBUTING.md); for the
test strategy see [TESTING.md](TESTING.md); for the user-facing architecture overview see the
[Architecture wiki page](../wiki/Architecture.md).

## Runtime shape

```
VS Code extension host (TypeScript, extension/src)
  ├─ custom editor per form  ──postMessage──►  canvas webview   (extension/media/designer.js)
  ├─ dockable panel          ──postMessage──►  Properties / Toolbox / Outline (extension/media/panel.js)
  └─ engine client ──JSON-RPC over a named pipe──►  one engine process per runtime
                                                    ├─ modern engine  (engine/, net10.0-windows)
                                                    └─ .NET Framework engine (engine-net48/, net48, x64)
```

- The host decides which engine renders a form, owns the document, undo/redo, saving and every diagnostic action.
- An engine parses `InitializeComponent`, builds live controls on a design surface, renders a PNG plus a layout
  tree, describes properties, and returns edited source text. An engine never writes the user's files.
- The modern engine interprets the source through allowlists and never runs code from the `.Designer.cs`. The
  .NET Framework engine replays the parsed statements onto the project's compiled controls, following the
  Visual Studio model.

## Top level

| Path | Contents |
|---|---|
| `engine/` | Modern engine (C#, `WinFormsDesigner.Engine`) and its sample forms (`engine/samples/`, data only) |
| `engine-net48/` | .NET Framework 4.8 engine; compiles about 20 shared files from `engine/` (listed below) |
| `extension/` | VS Code extension: `src/` host code, `media/` webviews, `package.json` contributions, `package.nls.*.json` |
| `tests/` | `Engine.UnitTests` (modern, xUnit) and `Engine.Net48.UnitTests` (net48, xUnit) |
| `fixtures/` | Build fixtures for tests: `FakeVendor` (vendor-like controls), `Net48CtxFixture`, `VisualStudioReference` (byte-pinned) |
| `samples/` | Sample projects: `CustomControls`, `ComplexProject` (multi-target), `DemoApp`, `DevExpressDemo` |
| `scripts/` | Bundling, CI gates, evidence collection and release runners |
| `docs/` | ADRs, release records, roadmaps, the v2 scenario catalog and archived Visual Studio reference traces |
| `wiki/` | Source of the GitHub wiki (user guide) |
| `.github/workflows/` | `ci.yml` (every push/PR) and `release.yml` (on a `v*` tag; publishes) |

## Modern engine (`engine/`)

| Area | Files |
|---|---|
| Entry and protocol | `Program.cs` (CLI verbs and the JSON-RPC pipe server), `V2Protocol.cs` (generated, byte-pinned) |
| Interpretation and render | `DesignerRenderer.cs` (`LoadGraph` → `Interpret` → `HandleAssignment`/`HandleInvocation`/`Eval`, layout and init bracket replay, PNG capture), `DesignerAllowlists.cs` (the security allowlists, shared with net48), `HeadlessDesignerUIService.cs` (designer errors become listed constructs, never dialogs) |
| Resources | `DesignerResx.cs`, `SafeResxResolver.cs`, `ProjectResourceResolver.cs` (`Properties.Resources.X` from the project's own `.resx`, bounded decoders), `DesignerProjectResourcePicker.cs` |
| Properties | `DesignerDescribe.cs`, `DesignerValueConverter.cs`, `DesignerPalette.cs`, `DesignerUiTypeEditorBroker.cs` / `DesignerUiTypeEditorWorker.cs` |
| Editing and save | `DesignerPropertyEditor.cs`, `DesignerControlEditor.cs` (add/remove/move controls), `DesignerComponentRename.cs`, `DesignerEventEditor.cs`, `DesignerModifiers.cs`, `DesignerSaveSplicer.cs`, `DesignerSerializer.cs`, `DesignerOwnedRegionSerializer.cs`, `SaveSafety.cs` (when whole-file regeneration is refused) |
| Collection editors | `DesignerCollectionEditor.cs`, `DesignerGenericListEditor.cs`, `DesignerStringArrayEditor.cs`, `DesignerGridColumnEditor.cs`, `DesignerListColumnEditor.cs`, `DesignerTreeNodeEditor.cs`, `DesignerToolStripItemEditor.cs`, `DesignerTableStyleEditor.cs`, `DesignerTableCellEditor.cs`, `DesignerImageEditor.cs`, `DesignerImageListEditor.cs`, `DesignerBindingEditor.cs`, `DesignerExtenderEditor.cs`, `DesignerDataSourceGenerator.cs` |
| Geometry and layout | `DesignerGeometry.cs`, `DesignerLayout.cs`, `DesignerAdornerInfo.cs` |
| Localization | `DesignerLocalizeForm.cs`, `DesignerLocalizedResxEditor.cs`, `DesignerCultureSelection.cs` |
| Projects and types | `ProjectResolver.cs`, `FormClassResolver.cs`, `ControlLoadContext.cs`, `CompiledRootFactory.cs` |
| Shared IR (also net48) | `DesignerIr.cs`, `DesignerIrBuilder.cs` (Roslyn front end), `DesignerIrExecutor.cs`, `InterpretedRenderPlan.cs`, `InterpretedDescribeResolver.cs`, `RenderModeDecision.cs`, `AssemblyIrHost.cs` |
| Hosted designers | `DesignerServiceKernel.cs`, `HostedServiceKernelProduct*.cs`, `HostedDesignerAdornerContract.cs`, `DesignTimeSite.cs`, `VsNameCreationService.cs`, `DesignerInheritedOverrideEditor.cs` |

Files compiled into **both** engines (edit with both runtimes in mind): `FormClassResolver.cs`, `DesignerModifiers.cs`,
`SaveSafety.cs`, `DesignerIr.cs`, `DesignerAllowlists.cs`, `DesignerIrBuilder.cs`, `DesignerIrExecutor.cs`,
`DesignTimeSite.cs`, `RenderModeDecision.cs`, `SafeResxResolver.cs`, `AssemblyIrHost.cs`, `CompiledRootFactory.cs`,
`InterpretedRenderPlan.cs`, `InterpretedDescribeResolver.cs`, `DesignerInheritedOverrideEditor.cs`,
`DesignerAdornerInfo.cs`, `HostedDesignerAdornerContract.cs`, `VsNameCreationService.cs`, `DesignerServiceKernel.cs`,
`HostedServiceKernelProductContract.cs`.

## .NET Framework engine (`engine-net48/`)

`Program.cs` (the same JSON-RPC pipe contract as the modern engine), `DomainManager.cs` (one child AppDomain per
project output directory) with `ChildDomainConfig.cs` (its configuration and binding redirects), `RenderWorker.cs`
(runs inside that domain), `RenderDesktop.cs` (runs the engine on a private desktop so preview windows stay off screen),
`CompiledDescriber.cs`, `RootTypeResolver.cs`, `SourceMetadata.cs`, `ToolboxAssemblyScanner.cs`, `VendorSmartTags.cs`,
`HostedDesignerBroker.cs`, `HostedServiceKernelBroker.cs`, `ImageListSerializer.cs`, `Dtos.cs`, `V2Protocol.cs`.

## Extension host (`extension/src/`)

| Area | Files |
|---|---|
| Activation and commands | `extension.ts` |
| Designer session | `designerEditor.ts` (custom editor provider, `DesignerHub`, per-form session: render, select, edit, save, toolbox) |
| Engines | `engineClient.ts` (spawn and RPC), `engineRecovery.ts` (crash-loop policy), `workerSupervisor.ts`, `workerSelection.ts`, `v2Protocol.ts` (generated) |
| Documents and save | `documentStore.ts`, `byteLocal.ts` (byte-local save), `atomicFile.ts`, `patchSet.ts`, `transactionJournal.ts`, `transactionRunner.ts`, `transactionRecovery.ts`, `resourceTransaction.ts`, `resourceTransactionCoordinator.ts`, `binaryResx.ts`, `localizable.ts`, `inlineDesigner.ts` |
| Projects and builds | `formProjectMembership.ts`, `solutionProjects.ts`, `projectCompatibility.ts` (architecture evidence: PE images plus MSBuild evaluation), `projectResources.ts`, `projectEventSources.ts`, `csprojRef.ts`, `externalBuild.ts`, `taskCoordination.ts`, `formSiblings.ts`, `scaffolding.ts`, `autoOpen.ts` |
| Diagnostics and status | `designerDiagnostics.ts` (reason catalogue and the redacted report), `formStatusView.ts`, `renderDiagnostics.ts`, `renderGate.ts`, `formNotice.ts`, `learnMore.ts` |
| Toolbox | `toolboxDiscovery.ts`, `toolboxRequest.ts`, `tierDCompatibility.ts` (COM/ActiveX boundary), `vendorTasks.ts` |
| Persisted state and adapters | `persistedDesignerState.ts`, `v2Migration.ts`, `v2AdapterManifest.ts`, `v2AdapterManifestRegistry.ts` |
| UI helpers | `selection.ts`, `multiProperty.ts`, `valueExpr.ts`, `dpiScale.ts`, `tabViewState.ts` |
| Localization | `i18n/en.ts` (source of truth) and `i18n/*.json` (six translations) |
| Test harnesses | `e2e.ts`, `webview-e2e.ts` + `webviewHarness.ts`, `extension-host-suite.ts`, `release21-extension-host-suite.ts`, `release21-upgrade-suite.ts`, `performance-baseline.ts`, `scenarioEvidence.ts`, `v2HeadlessValidate*.ts`, `v2Soak*.ts`, `v2Phase0Performance.ts` |

Unit tests sit next to their modules as `*.test.ts` (vitest, `npm test`).

Webviews (`extension/media/`): `designer.js` (canvas), `panel.js` (Properties, Toolbox, Outline), `chooseItems.js`
(Choose Toolbox Items). They have no type checker; CI runs `node --check` on each.

## Scripts (`scripts/`)

| Purpose | Files |
|---|---|
| Bundle engines into the VSIX | `bundle-modern-engine.mjs`, `bundle-net48-engine.mjs`, `assert-vsix.ps1`, `test-vsix-isolation.ps1` |
| CI text gates | `ci-l10n-parity.mjs`, `ci-mojibake-scan.mjs`, `release-preflight.mjs`, `generate-v2-protocol.mjs` |
| Visual Studio reference renders | `capture-visual-studio-reference-traces.ps1`, `compare-visual-studio-reference-renders.ps1` |
| v2 scenario evidence | `validate-v2-scenario-catalog.ps1`, `collect-v2-test-evidence.mjs`, `validate-v2-execution-evidence.mjs`, `test-v2-execution-evidence-gate.mjs`, `reconcile-v2-catalog-evidence.mjs`, `v2-evidence-provenance.mjs` |
| Extension Host and release runners | `run-extension-host-tests.mjs`, `run-release21-extension-host-tests.mjs`, `run-release21-upgrade-tests.mjs`, `release21-environment.mjs` |

## Documents (`docs/`)

| Path | Contents |
|---|---|
| `adr/` | Architecture decisions: 0001 net48 live-source interpretation, 0002 edit parity, 0003 hosted services and dual-lane persistence; `adr/evidence/` holds the subsystem maps 0001 was based on |
| `release-2.0.0-gate-record.md`, `release-2.1.0.md` (+ `release-2.1.0/`) | Release records with the machine reports they cite |
| `roadmap-2.0.0-to-3.0.0.md`, `roadmap-v2.0.0-implementation-plan.md`, `roadmap-to-2.0.0.drawio` | Plans; the short public roadmap is the root `ROADMAP.md` |
| `v2/` | Protocol and adapter-manifest schemas, the scenario catalog (`vs-parity-scenario-catalog.tsv`), archived Visual Studio reference traces and comparisons (byte-pinned) |
| `TESTING.md`, `arm64-support.md` | Test strategy; ARM64 status |
| `images/` | Screenshots used by the docs |

The maintained changelog is the root `CHANGELOG.md`; `extension/CHANGELOG.md` is a build copy.

## Flows

- **Open a form.**
  1. `designerEditor.ts` resolves the owning project and the engine route.
  2. It checks the output's architecture from its image. MSBuild evaluation of the project finishes in the
     background and can still refuse the form.
  3. It starts the engine and posts the render (PNG plus layout) to the canvas.
- **Edit a property.**
  1. The panel sends the edit.
  2. The host asks the engine for edited source.
  3. The new text goes into `documentStore.ts` as one undo step.
  4. The canvas re-renders, or applies the edit to the retained graph.
- **Save.** `byteLocal.ts` and `atomicFile.ts` write the in-memory text verbatim, with the `.resx` in the same
  transaction (`transaction*.ts`).
- **Release.**
  1. `ci.yml` must be green.
  2. A `v*` tag runs `release.yml`.
  3. It rebuilds and re-tests, packages and asserts both VSIX, and creates a draft GitHub Release.
  4. It publishes to the Marketplace, makes the release public, then publishes to Open VSX.
