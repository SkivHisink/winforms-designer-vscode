# Release 2.1.0 — diagnostics, compatibility and recovery

Date: 2026-10-02. **R21-01–R21-08 and the engine fixes for #6 and #7 implemented and verified locally; both packages built. Publication not performed.**

This record covers R21-01 through R21-08 of the
[2.0.0–3.0.0 roadmap](roadmap-2.0.0-to-3.0.0.md). It is an independent release record:
the earlier 2.0 scenario ledger is historical evidence and is not re-certified by these changes.

## Product changes

| Task | Implemented behavior | Primary implementation |
|---|---|---|
| R21-01 | Form Status reports the current form's project, evaluated framework/configuration, engine, worker architecture, culture, preview source, dirty state, capabilities and observed build history | `extension/src/extension.ts`, `formStatusView.ts`, `designerEditor.ts` |
| R21-02 | A host-owned catalogue maps stable reasons to affected targets and allowed recovery actions; status actions revalidate document and source revision | `designerDiagnostics.ts`, `formStatusView.ts` |
| R21-03 | Both render routes inspect evaluated project properties and actual output PE architecture, with explicit UNKNOWN when evidence is incomplete | `projectCompatibility.ts`, `designerEditor.ts` |
| R21-04 | COM, WPF and invalid toolbox scopes have named host-side refusals; the existing source ActiveX gate remains in place | `toolboxRequest.ts`, `designerEditor.ts`, `media/chooseItems.js` |
| R21-05 | Registry diagnostics distinguish invalid declarations, duplicate identities and contextual compatibility; no declaration activates code | `v2AdapterManifestRegistry.ts`, `v2AdapterManifest.ts` |
| R21-06 | Disposable cache rebuild, explicit rediscovery and existing worker restart preserve document/source history and user curation | `designerEditor.ts`, `extension.ts`, `persistedDesignerState.ts` |
| R21-07 | Activation awaits actual toolbox scope migration, preserves legacy data and diagnoses invalid state and failed migration writes | `persistedDesignerState.ts` |
| R21-08 | Export and clipboard copy use the same bounded, allowlisted JSON report with a safe Markdown envelope | `designerDiagnostics.ts`, `extension.ts` |

All implementation paths in the table are relative to `extension/src/` unless explicitly prefixed.
The UI and reason catalogue have English, Russian, Simplified Chinese, French, German, Spanish and Hindi translations.

## Engine fixes in this release

These change the modern engine's render path, so every host, upgrade and package result below was re-executed
on the engines that contain them.

| Issue | Behavior | Implementation |
|---|---|---|
| [#7](https://github.com/SkivHisink/winforms-designer-vscode/issues/7) | `SuspendLayout`/`ResumeLayout`/`PerformLayout` and `ISupportInitialize.BeginInit`/`EndInit` are replayed on the real instances in source order. `EndInit` closes only a `BeginInit` the same pass opened on that instance. Brackets the source leaves open are closed at the end, and a failure while closing one is listed by name. A final top-down layout pass lays out deferred docking. A nested container keeps its designed scale, as in Visual Studio | `engine/DesignerRenderer.cs` (`BracketReplay`, `SettleLayout`) |
| [#6](https://github.com/SkivHisink/winforms-designer-vscode/issues/6) | Root nested assignments (`this.Appearance.Font`) target the root instance; a field of that name is never retargeted. `DevExpress.XtraLayout.Utils.Padding` may be constructed only from an assembly named `DevExpress.*` that carries DevExpress's public key token | `engine/DesignerRenderer.cs`, `engine/DesignerAllowlists.cs` |
| #6 | `Properties.Resources.X` images (Bitmap, Icon, DevExpress `SvgImage`) come from the project's own `.resx`, and the generated accessor never runs. A value is used only when all of the following hold: C# name binding selects exactly one canonical generated accessor class; that class declares the member; its `ResourceManager` base name equals the manifest name MSBuild would assign, as proven from the project file. A `Directory.Build.*` file that mentions resource naming, `LogicalName`/`ManifestResourceName`/`DependentUpon`/`Remove` on the item, or an unlisted resource in an old-style project leaves the value unproven, and it stays a listed skipped construct | `engine/ProjectResourceResolver.cs`, `engine/DesignerProjectResourcePicker.cs` |
| #6 | Files are read only inside the owning project. No symbolic link or junction is followed, including a linked `Directory.Build.*`, and the name that is checked is the name that is opened. Decoding is bounded: PNG, GIF, ICO, JPEG and BMP are checked from their headers before any pixel is decoded; metafiles and TIFF are refused. An SVG must have an `<svg>` root and no DTD after a document type declaration is dropped, and its size, depth and `<use>` expansion are limited | `engine/ProjectResourceResolver.cs` |
| — | A compiled base form whose constructor throws opens as the documented incomplete framework preview | `engine/DesignerRenderer.cs` (`LoadGraph`) |
| — | The design surface has a headless `IUIService`. An error that a control designer would show in a modal dialog is listed as "the designer disabled a control: …". Before this, the dialog appeared on the desktop and blocked the engine | `engine/HeadlessDesignerUIService.cs` |

Engine evidence:
- C# unit tests: **612/612** (net10) and **50/50** (net48).
- The Visual Studio reference-render gate and the M6 interpretation-coverage gate pass (35 samples; 91.43 % interpreted, minimum 80 %).
- The headless end-to-end suite passes with `WFD_REQUIRE_NET48=1`.
- A real DevExpress **25.2.5** `XtraForm` on .NET 10 renders with zero skipped statements. The form has a `LayoutControl`, an SVG project resource and `Appearance.Font`.
- All 3063 SVG images of the DevExpress 25.2 gallery pass the SVG checks and render. The 6563 SVG images installed with or embedded in DevExpress 25.2 render identically after the document-type cleanup. All 1727 loadable icon files on the build machine pass the icon checks.
- Renders of 103 sample and fixture forms were compared with 2.0.0 and with the runtime layout of the same code. 21 differ, and each one is closer to runtime.

DevExpress versions without .NET 10 support (before 25.2) fail inside their own constructors on .NET 10. They
are not covered beyond opening as the incomplete preview. The `Padding` construction rule extends a security
allowlist. A unit test pins its identity check with an assembly that carries the DevExpress public key token.

## Using the support commands

Open a form in the designer, then run **WinForms: Show Form Status** from the Command Palette.
The panel displays the form it inspected. Use its explicit Refresh action after changing the project or build output.
Local inspection includes project/assembly identities; the shared diagnostic report does not include these paths.

Diagnostic actions are offered only when applicable. They can retry rendering, open the form source, choose a
control assembly, run a build, clear the disposable cache or restart engines. A changed document/revision invalidates
an old action. The existing build task and assembly picker keep their ordinary user interaction.

**Rebuild Toolbox Cache** clears only rebuildable reflection metadata and refreshes the active toolbox.
**Refresh Toolbox** repeats control discovery. Neither command clears selected/hidden controls, custom toolbox tabs,
settings, resources, unsaved documents, backups or transaction journals. Within the window that clears the cache,
cache generations prevent a scan started before the clear from restoring stale entries or publishing stale Choose
Items rows. The cache is shared by all windows, but each window keeps its own copy. Another open window can write
its earlier copy back until it is reloaded. The cache holds only rebuildable metadata keyed by file stamps.

**Choose Toolbox Items** opens the .NET chooser. API callers can explicitly pass `net`, `com` or `wpf` to
`winformsDesigner.requestToolboxItems`. COM returns `COM_ACTIVE_X_UNSUPPORTED`; WPF returns
`WPF_TOOLBOX_UNSUPPORTED`; malformed scopes return `TOOLBOX_SCOPE_INVALID`. A refusal does not start discovery
or grant a mutation. The visible COM/WPF tabs display the same refusal code.

**Export Designer Diagnostics** opens a Markdown document; **Copy Diagnostics** uses the same report boundary.
The report includes versions, environment, worker lifecycle counters, session flags, capability facts, measured
timings, correlation ID and canonical diagnostic codes. The JSON is at most 60 KiB and the whole Markdown report
at most 64 KiB. Source statements, property values, settings, raw engine errors and private paths are excluded.
Control/target/assembly identities are replaced by labels local to one bundle. No automatic upload occurs.

## Architecture and build evidence

Architecture inspection runs only in a trusted workspace. It evaluates MSBuild properties without requesting
build, restore or targets, with a 12-second evaluation deadline and bounded subprocess output. MSBuild evaluation
is design-time execution; this is not the future parse-only mode from R211-02.

A render does not wait for that evaluation. It waits at most 200 ms for a cached evaluated result. Otherwise it is
gated on the image evidence it can read at once: the selected output and its known dependencies. Evaluation takes
about a second on a warm machine and much longer cold, and it finishes in the background. An incompatibility
only the evaluation can show refuses the form when the evaluation completes. Two examples are a required-x86
project setting with no built output and an evaluated reference built for another architecture. In the S016
300-control open, measured on the build machine across six runs, the first .NET Framework render dropped from about
4.3–5.0 s to 1.6–3.9 s. The range depends on whether that engine was already warm. The modern render dropped from
about 3.1 s to 2.1–2.8 s.

The inspector distinguishes AnyCPU, required x86, x64, ARM64, native/mixed-mode images and unreadable metadata.
It checks at most 1 MiB of each image and 16 known dependencies. Unknown or incomplete evidence is visible and
does not become a compatibility certificate. Transitive dependencies, arbitrary P/Invoke loads and vendor behavior
are not proven by this inspection. A native apphost is refused as a selected managed form assembly.

`Prefer32Bit` on a managed EXE is not, by itself, a requirement for an x86 worker; preferred-32 DLL metadata is
treated differently. The modern preflight is bound to the actual resolver-selected output used by rendering,
so a stale default Debug output cannot override a valid selected Release assembly.

The .NET Framework worker remains x64. An ARM64 package does not imply physical ARM64 acceptance.
Successful metadata checks do not enable x86/COM execution or certify a vendor adapter.

The status panel's last-build field reports only an exit-zero workspace build task observed during this extension
session. Its project attribution is explicitly unverified. Output timestamps and the mere existence of a DLL are
not reported as a successful build. Before such a task is observed, the field remains unknown.

## Persisted state and migration

The source inventory is `extension/src/persistedDesignerState.ts` and its configuration list is tested against the
contributed settings in `extension/package.json`.

| Existing state | Storage and representation | 2.1 behavior |
|---|---|---|
| `winformsDesigner.*` | 14 VS Code configuration settings | Existing types and ownership retained |
| `chosenToolboxItems`, `hiddenToolboxFqns`, `toolboxUiState`, `browsedToolboxAssemblies` | Existing unversioned global/workspace mementos | Awaited migration seeds only missing workspace values; global originals are retained |
| `toolboxScanCache` | Global map of file/probe stamps to reflection results | Disposable; bounds and sanitation; serialized writes/clear |
| `designerViewStates` | Workspace canvas, panel, selected tabs and culture | Preserved across cache clear |
| `controlSources` | Workspace per-form assembly overrides | Preserved across cache clear |
| `v2-transactions/...` | Existing journal schema 2.0.0 in global storage | Existing recovery rules retained; never a cache-clear target |
| `hot-exit-recovery-v1.json` | Existing workspace recovery index | Preserved; no format change |
| CustomDocument backup destination | Exact generated-source bytes, including BOM | Preserved; no new envelope or migration |

No new persistence schema or artificial migration cache is introduced. Existing workspace values take precedence,
including values that require manual recovery. Invalid persisted data is sanitized for in-memory use and diagnosed;
loading and migration do not overwrite the stored original. A later toolbox view change (tab, list/icon view, sort)
does write `toolboxUiState`: it stores the sanitized view state over the invalid original. A failed migration
write is retried on the next activation. Retaining legacy
global values makes the existing old reader's data available after downgrade. The installed version transition
below verifies this against a reconstructed exact repository 2.0.0 baseline; it is not a claim about the byte identity
or publication history of an older Marketplace package.

## Verification record

| Task | Unit/integration (`extension/src/`) | Real Extension Host / installed transition |
|---|---|---|
| R21-01 | `formStatusView.test.ts` | HOST-002 modern and net48: Form Status names the engine that actually rendered |
| R21-02 | `designerDiagnostics.test.ts` | HOST-004, HOST-005, HOST-006: a stable code with at least one action |
| R21-03 | `projectCompatibility.test.ts` | HOST-004: the x86-only fixture is not rendered |
| R21-04 | `toolboxRequest.test.ts` | HOST-004: `com` is refused with `COM_ACTIVE_X_UNSUPPORTED`, and no engine is launched or recycled |
| R21-05 | `v2AdapterManifest.test.ts`, `v2AdapterManifestRegistry.test.ts` | HOST-007: duplicate identities are refused, published to Problems and left unmodified |
| R21-06 | `persistedDesignerState.test.ts` | HOST-003 modern and net48: cache rebuild, refresh and restart keep the dirty source, revision and native Undo. The upgrade run persists a real cache clear |
| R21-07 | `persistedDesignerState.test.ts` | Installed 2.0 → 2.1 → 2.0 transition |
| R21-08 | `designerDiagnostics.test.ts` | HOST-005: the redacted export contains no sentinel and has its privacy flags false |

HOST-001 checks that every new command is registered. Each host and upgrade report records the commit, the
working-tree state, the OS, the Node architecture and the .NET runtimes it ran on. It also records the SHA-256 of
every artifact it exercised.

All results below were produced on 2026-10-02 from the final source, with the #6/#7 engine fixes in place.
The runs came before the release commit. They ran on the working tree over `72a4ee3`, which the machine reports
record as dirty. The release commit adds exactly that tree, with no further product changes. The artifacts are
bound by their recorded SHA-256 hashes.

- Extension unit/integration layer: the full vitest suite passed **470/470** in 48 files. This includes the
  2.1 architecture, persisted-state, diagnostics, status UI, toolbox-request and adapter manifest/registry tests.
- Headless webview suite: **970 checks across 209 tests**, 0 failed.
- TypeScript type checking and the extension bundle build pass.
- Strict localization parity: **567 runtime keys / 42 package keys** in every locale, including placeholder parity.
- Mojibake scan: passed for **758 tracked text files**.
- Release metadata preflight: passed for **2.1.0**. This deliberately does not certify Git cleanliness or tag identity.
- Real Extension Host on VS Code **1.84.0**: **9/9 PASS**, exit 0; [retained machine report](release-2.1.0/host-1.84.0.json).
- Real Extension Host on VS Code **1.135.0**: **9/9 PASS**, exit 0; [retained machine report](release-2.1.0/host-1.135.0.json).
- Both runs record identical SHA-256 hashes for the extension bundle, the suite and the two engines.
- Installed 2.0 → 2.1 → 2.0 on VS Code 1.135.0: **PASS**, exit 0, three normal application phases and eight
  persistence/recovery assertions. [Retained machine report](release-2.1.0/upgrade-downgrade-1.135.0.json).
  The run used real global/workspace SQLite storage, preserved workspace/legacy-global curation and unrelated
  journal/backup bytes, and persisted the real cache-clear command. Version 2.1 created an actual dirty
  CustomDocument backup on normal workbench exit. Installed 2.0 restored that unsaved source and performed
  native Undo/Redo while the source file on disk stayed unchanged.
- Windows x64 and ARM64 VSIX creation and `scripts/assert-vsix.ps1`: **PASS** for both target/RID/PE combinations.
  Both package the exact extension bundle used by the two final Extension Host runs. Each contains 204 entries;
  the release test suite is excluded, and all 23 non-engine entries match byte-for-byte between targets.
  Both engine assemblies declare 2.1.0.0. [Retained package hashes and sizes](release-2.1.0/packages.json).
- Every `ci.yml` step was mirrored locally on this tree. All steps passed except the release preflight's
  clean-tree check, which needs the release commit. The mirrored steps include:
  - the historical Extension Host suite on VS Code 1.84.0 and Stable;
  - the performance baseline;
  - the measured v2 scenario evidence validation;
  - the adversarial controls of that gate.
- `npm audit`: 0 vulnerabilities. The test-only `jsdom` dependency pulled `undici` 7.29.0, which new advisories
  affect. The existing override now pins 7.29.1. The extension bundle is unchanged, because `undici` is not
  bundled, so both packages and the upgrade run were rebuilt and re-run after the change.
- `ci.yml` must still pass on the release commit before the tag is pushed.

The dedicated runner is:

```powershell
node scripts/run-release21-extension-host-tests.mjs --version=1.84.0
node scripts/run-release21-extension-host-tests.mjs --version=1.135.0
```

It creates disposable projects and profiles and checks real modern/net48 rendering, status, dirty-source recovery,
native Undo, x86/COM refusal, missing types, invalid configuration, redacted exports and duplicate manifests.
Machine-readable reports are written under `extension/.vscode-test/release21-host-<version>.json`.
The test bundle is excluded from the VSIX.

The installed transition runner is:

```powershell
node scripts/run-release21-upgrade-tests.mjs --version=1.135.0 --baseline=72a4ee3
```

It reconstructs the old extension and both old engine binaries from the exact baseline commit, installs actual
VSIX packages using the VS Code CLI, and launches normal VS Code processes with isolated user data, extensions
and shared-data directories. A separate development harness observes the installed product. Released state
shapes are seeded into the closed profile's actual SQLite databases, using the real case-sensitive extension key.
`--extensionTestsPath` is deliberately avoided because this host uses in-memory mementos in that mode.
The successful profile and reconstructed baseline are retained under the ignored test directory for inspection.

## Limits of this evidence

These are narrower than the roadmap wording and are recorded here instead of being implied by a passing run:

- **Form Status framework (R21-01):** the panel reports the *evaluated* target framework. For a project with
  several `TargetFrameworks` it shows Unknown; it does not choose one.
- **Reason → recovery (R21-02/R21-03):** no host scenario presses a Form Status action on a form with an active
  reason. The missing-type scenario accepts either `MISSING_TYPE` or `ARCHITECTURE_UNKNOWN`, because its fixture
  is not built. The x86/COM scenario does not tell an x86 refusal from a COM refusal. Status fields are checked for
  presence, not for their values.
- **Adapter diagnostics (R21-02/R21-05):** for an `ADAPTER_*` reason, **View Code** opens the form, not the
  manifest. The contextual runtime/architecture check in Form Status is not exercised by any test. Only duplicate
  identity is proven in the host.
- **Adapter manifests (R21-05):** discovery uses `**/.winforms-designer/adapter-manifest.json` and is bounded to
  64 manifests of at most 256 KiB, 32 diagnostics and 1024 characters per message. An identity declared by more than one
  manifest is reported as duplicate, and none of those declarations is accepted. Versions are now strict SemVer: `02.1.0` and `2.1.0-01`, which
  2.0 accepted, are invalid.
- **Recovery (R21-06):** no test observes the effect of **Rebuild Toolbox Cache** or **Refresh Toolbox** in the
  host. No test covers the cache-generation guard against a scan started before a clear. The guard does not span
  windows (see "Using the support commands").
- **Persisted state (R21-07):** only migration writes and the disposable cache report a failed write. If VS Code
  rejects an ordinary preference write (Choose Items, hidden controls, toolbox view, browsed assemblies), the change
  applies to the current session only, and no diagnostic is shown.
- **Diagnostics export (R21-08):** the redacted export is proven on a modern-engine form only. The .NET
  Framework route is not exercised.
- **COM/ActiveX (R21-04):** an `AxInterop` wrapper assembly offered by the .NET chooser is not filtered. Dropping
  one changes the document before the source ActiveX gate refuses the form. This behavior is unchanged from 2.0
  and has not been reproduced with a real wrapper.
- **Project resources (#6):** every reparse point is refused, not only links. This includes cloud placeholders
  such as OneDrive Files On-Demand and deduplicated files. A resource pair stored that way is not read; the
  expression stays a listed skipped construct. If the resource walk hits a limit or an unreadable or linked folder,
  the walk is incomplete. A non-qualified `Properties.Resources.X` then does not fall back to an outer namespace's
  class.
- **Late refusal (R21-03):**
  - when only the project evaluation finds an incompatibility, the picture rendered before it stays visible behind
    the refusal banner, and the form is read-only until fresh evidence lifts the refusal;
  - if the project is rebuilt while an edit is still waiting for the engine, the form can stay read-only until the
    next Retry.
- **Accessibility:** the new panels have no keyboard test. Known obstacle: the COM and WPF tabs of Choose Toolbox
  Items are not keyboard-focusable.

## Release boundary

Physical ARM64/DPI validation, licensed-vendor certification and broader Visual Studio parity retain their earlier
separate acceptance gates. This work does not publish a package, create a Git commit or tag, or rewrite the historical
2.0 acceptance ledger. Packaging checks, when executed, establish artifact contents and architecture only.
