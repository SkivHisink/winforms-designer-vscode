# Release 1.4.0 completion record

Last updated: 2026-08-03

This is the auditable execution record for the roadmap outcomes assigned to 1.4.0 and the editor-framework outcomes that remained open after the v1.3.0 tag. It records repository-side implementation and verification only. Marketplace/Open VSX publication still requires a deliberate tag push and configured publication credentials.

## Baseline and scope

- Baseline commit: `8f971ad` (`master`, tagged `v1.3.0`); the worktree was clean at the start of the audit.
- Package baseline: `extension/package.json` and `extension/package-lock.json` both reported `1.3.0`.
- The existing v1.3.0 changelog covered vendor-form interpretation and render performance, but the broader 1.3.0 editor-framework outcomes in `ROADMAP.md` were still open.
- No commit, push, tag, Marketplace publish, or Open VSX publish was performed by this execution.

## Work-wave closure

| Wave | Outcome | Initial audit | Final repository-side result |
| --- | --- | --- | --- |
| W1 | Metadata-driven expandable values | OPEN: the property panel used a hard-coded complex-type list | CLOSED: both engines expose bounded recursive `TypeConverter` metadata with path/category/description/standard-value data, explicit truncation, and depth/node/child/cycle/exception guards. Nested metadata stays display-only without a safe writer. |
| W2 | Generic `IList` / `IList<T>` adapter framework | OPEN: unsupported content collections were deliberately read-only | CLOSED: a bounded source-first adapter handles allowlisted string, primitive, enum/flags, and safe complex item shapes. Ambiguous/unsafe/trivia-sensitive forms fail closed. Interface-only `IList<T>` output is semantically compiled in the test corpus; `AddRange` is retained only where the source proves the concrete target supports it, otherwise the writer emits repeated `Add` calls. |
| W3 | Cancellable isolated `UITypeEditor` broker | OPEN: no editor invocation RPC or broker existed | CLOSED for the explicit supported surface: `ColorEditor`/`Color` and `FontEditor`/`Font` run in a short-lived worker with timeout, cancellation, bounded streams, strict JSON, process-tree cleanup, and invariant-value revalidation. Arbitrary project/vendor/resource editors remain disabled. |
| W4 | Source-first complex edit transaction | PARTIAL: bespoke editors already had safe splices and one undo unit | CLOSED: generic list and supported modal-editor commits use current metadata/revision authority, engine-produced minimal previews, the existing persistence firewall, authoritative re-render, and one undo unit. |
| W5 | Safe inherited-form editing | PARTIAL: identity/read-only resolution was not consistently exposed by the public layout contract | CLOSED: modern and net48 descriptions carry `root` / `currentSource` / `inherited` / `unresolved` ownership; the UI and server mutation routes enforce inherited/unresolved read-only policy. Current-source property writes remain available on an unresolved base, while direct geometry fails closed because base layout constraints cannot be inferred. |
| W6 | Visual TableLayoutPanel / FlowLayoutPanel tools and outline reparent/reorder | PARTIAL: engine primitives existed; outline was selection-only | CLOSED: outline drag/reparent/reorder plus keyboard/context ordering compose with the existing source-first table-cell/style and flow-order writers, one undo unit, and full re-render. Invalid/self/descendant/read-only targets are refused. |
| W7 | Engine-authoritative geometry | PARTIAL: layout-managed children were blocked, but final free-control geometry was client-authoritative | CLOSED for the supported modern free-control surface: the live WinForms graph applies, lays out, corrects, and returns final bounds before a source preview is accepted. Docked, auto-sized, layout-managed, inherited, unresolved-base, custom, and unsafe shapes fail closed. |
| W8 | HiDPI coordinate matrix | PARTIAL: integer backing scaling existed; fractional DPR was rounded and not release-gated | CLOSED: exact display DPR is tracked independently from capture scale. DPR `1` uses 1x capture; `1.25`, `1.5`, `1.75`, and `2` use safe 2x capture while all hit testing and source geometry stay in logical WinForms pixels. |
| W9 | Native modern Windows ARM64 package | OPEN: only `win32-x64` / `win-x64` were produced | CLOSED: CI/release/package scripts produce and validate separate x64 and ARM64 VSIX files, runtime identifiers, and PE machines. The net48 engine is intentionally documented and asserted as an x64 compatibility fallback in the ARM64 package. |
| W10 | Version, changelog, roadmap, and public documentation | OPEN | CLOSED: package/lock are `1.4.0`; changelog, roadmap, draw.io roadmap, testing guide, ARM64 policy, root README, and Marketplace README describe the implemented surface and external gates. |

## Release-gate evidence

A command that stops without a terminal summary, an environment failure, or a skipped runtime leg is recorded as gated rather than passed.

| Gate | Terminal evidence | Result |
| --- | --- | --- |
| G1 modern engine unit suite | `dotnet test tests/Engine.UnitTests -c Release`: 245 passed, 0 failed, 0 skipped. A focused post-review generic-list/geometry rerun passed 19/19. | PASS |
| G2 .NET Framework engine unit suite | Release build passed with 0 errors. The xUnit restore was blocked by `NU1301` TLS/authentication failure for `https://api.nuget.org/v3/index.json`; therefore no full unit-test pass is claimed. A real net48 worker smoke covered the new metadata/ownership guards, the xUnit source compiled through Roslyn, and G7 exercised the real net48 engine. | GATED for xUnit restore; implementation/build/smoke evidence passed |
| G3 extension type check | `npm run typecheck`. | PASS |
| G4 extension unit suite | `npm test`: 8 files, 58 tests, 0 failed. | PASS |
| G5 built extension and real host smoke | `npm run build`; `node --check media/designer.js`; `node --check media/panel.js`; final x64 bundle plus Extension Host smoke on VS Code 1.84.0 and Stable 1.131.0. Both real-host runs activated the extension/.NET 10 engine and exited with code 0. | PASS |
| G6 live webview | `npm run webview-e2e`: 584 checks across 147 tests, 0 failed. | PASS |
| G7 headless cross-runtime E2E | `WFD_REQUIRE_NET48=1 npm run e2e` completed against real modern and net48 workers after the final generic-writer fix. | PASS |
| G8 release text/integrity | Final rerun: `release-preflight --tag=v1.4.0` passed; mojibake scan passed across 252 tracked text files; strict localization parity passed with 380 runtime and 22 package keys for each of `ru`, `zh-cn`, `fr`, `de`, `es`, and `hi`; `npm audit --audit-level=moderate` reported 0 vulnerabilities. | PASS |
| G9 packaging | Both final VSIX files contained 201 entries and passed target/RID/PE assertions. x64: 17,763,449 bytes, modern/net48 `0x8664`; ARM64: 17,751,248 bytes, modern `0xAA64`, net48 fallback `0x8664`. | PASS |
| G10 artifact hygiene | Final `git diff --check` passed; all local links resolved in 7 changed/untracked Markdown files; draw.io XML parsed with 49 unique IDs and no duplicates; G8 was rerun after this record was written. | PASS |

## Final package artifacts

| Artifact | SHA-256 |
| --- | --- |
| `extension/winforms-designer-win32-x64.vsix` | `2C9F964BAE432F573594C768AAF8545B6FA1DD57F5DDC5A87FD08D6FF93EAC48` |
| `extension/winforms-designer-win32-arm64.vsix` | `0F7E66EDF49ED6C6302AF5A42AD3ED2918B19B082762556A66D7A1C362C236C1` |

## Independent review closure

The final read-only re-audit found no new regression and confirmed all three earlier findings resolved:

1. Interface-only `IList<T>` properties no longer receive uncompilable `AddRange` calls; the exact case is semantically compiled by the Roslyn-backed unit test.
2. Unresolved-base geometry is explicitly fail-closed in tests and documentation, while the narrower current-source property-edit capability remains documented.
3. The manual ARM64 instructions retain `WFD_BUNDLE_RID=win-arm64` across `vsce` prepublish and assert target, RID, modern ARM64 PE, and net48 x64 fallback PE.

## Exact changed-file inventory

- CI/release: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `scripts/assert-vsix.ps1`, `scripts/release-preflight.mjs`.
- Public documentation: `CHANGELOG.md`, `README.md`, `ROADMAP.md`, `docs/TESTING.md`, `docs/arm64-support.md`, `docs/release-1.4.0-completion-plan.md`, `docs/roadmap-to-2.0.0.drawio`, `extension/README.md`.
- Modern engine: `engine/DesignerDescribe.cs`, `engine/DesignerGenericListEditor.cs`, `engine/DesignerGeometry.cs`, `engine/DesignerLayout.cs`, `engine/DesignerRenderer.cs`, `engine/DesignerUiTypeEditorBroker.cs`, `engine/DesignerUiTypeEditorWorker.cs`, `engine/Program.cs`.
- .NET Framework engine: `engine-net48/Dtos.cs`, `engine-net48/RenderWorker.cs`.
- Extension/webview: `extension/package.json`, `extension/package-lock.json`, `extension/media/designer.js`, `extension/media/panel.js`, `extension/src/designerEditor.ts`, `extension/src/dpiScale.ts`, `extension/src/dpiScale.test.ts`, `extension/src/engineClient.ts`, `extension/src/engineClient.test.ts`, `extension/src/webview-e2e.ts`.
- Engine tests: `tests/Engine.UnitTests/DesignerExpandableMetadataTests.cs`, `tests/Engine.UnitTests/DesignerGenericListEditorTests.cs`, `tests/Engine.UnitTests/DesignerGeometryTests.cs`, `tests/Engine.UnitTests/DesignerInheritedOwnershipTests.cs`, `tests/Engine.UnitTests/DesignerUiTypeEditorBrokerTests.cs`, `tests/Engine.Net48.UnitTests/InheritedOwnershipPolicyTests.cs`.

## External boundary

- Real Windows ARM64 hardware, multi-monitor visual fidelity, and x64-emulated net48/vendor/COM/ActiveX/device stacks were NOT EXECUTED. A valid package is not a compatibility claim for every external dependency.
- The full net48 xUnit leg is GATED by the external NuGet TLS/authentication failure described in G2; its successful build, targeted worker smoke, source compilation, and real cross-runtime E2E do not get relabeled as that missing test run.
- Marketplace/Open VSX publication and external credentials were NOT EXECUTED. No commit, push, or tag was created.

## Closure verdict

W1-W10 and every applicable repository-local release gate are complete. The final verdict is **REPOSITORY-SIDE CLOSED WITH EXPLICIT EXTERNAL GATES**. The full net48 xUnit leg remains accurately GATED by external restore failure; hardware/vendor compatibility and publication remain NOT EXECUTED. No commit, tag, push, or publication was created.
