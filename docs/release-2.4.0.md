# Release 2.4.0: vendor cohort and applied editors

Date: 2026-10-22  
Status: **IN PROGRESS — cohort discovery, implementation and acceptance pending**

This record tracks R25-01 through R25-08 in the [2.x roadmap](roadmap-2.0.0-to-3.0.0.md).
This release follows the combined 2.3.0 working tree over `b7717b4`; its final local acceptance is still pending.
The combined [2.3.0 record](release-2.3.0.md), its implementation and unrelated working changes are preserved.
Final 2.4.0 product inputs cannot be frozen until that prerequisite release and the R25 changes have settled.

## Implementation plan

- [x] Read the roadmap, project map, current release boundary and initial dirty-tree state.
- [ ] Inventory the actual vendor assemblies and reference environment; select an exact available cohort.
- [ ] Map the applied editor, action, graph-isolation and adapter lifecycle paths to R25 requirements.
- [ ] Implement the bounded missing product behavior and an artifact-bound certification passport and acceptance runner.
- [ ] Verify ordinary vendor workflows, failure isolation, version coexistence and the independent cross-tool round trip.
- [ ] Run the required final-tree checks, freeze packages, retain evidence and record each R25 verdict.

## Acceptance ledger

| Task | Required evidence | Status |
|---|---|---|
| R25-01 | An actual available vendor product and exact version; repository fixtures are distinguished | PENDING |
| R25-02 | Passport with assembly hashes, runtime/architecture, service/editor requirements, exceptions and reference identity | PENDING |
| R25-03 | Real open/select/property/action/collection/save/undo/reopen/build workflow | PENDING |
| R25-04 | Applied collection identity, naming, references, ordering and unknown-property preservation | PENDING |
| R25-05 | Two actual suite versions remain isolated; upgrade invalidation is scoped to the changed graph | PENDING |
| R25-06 | Hang, editor/converter exception, invalid result, licensing and native dependency failures stay isolated | PENDING |
| R25-07 | Archived VS Code → Visual Studio → VS Code source/resource/build round trip | PENDING |
| R25-08 | Enable/disable/upgrade/downgrade preserves the document and reports exact compatibility | PENDING |

## Evidence and release boundaries

The first candidate is DevExpress because the repository has a net48 sample. An installed assembly, a successful
runtime render or a repository test fixture alone is not a complete Tier C certification. The exact cohort must
meet the roadmap's threshold and every mandatory workflow. An executable adapter grant and a certification passport
are separate authorities; a passport does not enable code execution.

If licensed artifacts or independent reference evidence are unavailable, the general editor improvements may be
released under their exact scope while vendor certification remains **GATED**. No repository fixture substitutes
for the real vendor cohort. Publication, physical ARM64 and native UI qualification retain their own evidence gates.

The SDK Preview packages target the combined 2.3.x product cohort. Their existing product ranges remain authoritative:
supporting 2.4.0 requires an explicit compatibility decision and package update, with the old package retained as a refusal
witness. Previous acceptance results do not automatically cover modified source, package or dependency bytes.
