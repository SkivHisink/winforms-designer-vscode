# Release 2.3.0: documents, history, recovery, hosted services and Adapter SDK Preview

Date: 2026-10-27  
Status: **ACCEPTED LOCALLY — all 45 executable CI steps passed on the final product tree; publication pending**

This is the single combined record for R23-01 through R23-12 and R24-01 through R24-09 in the
[2.x implementation roadmap](roadmap-2.0.0-to-3.0.0.md#milestones), following the
[23 October 2026 revision](roadmap-2.0.0-to-3.0.0.md#roadmap-revision-2026-10-23).
Both task groups ship as product 2.3.0; their task, scenario and suite identifiers remain unchanged.
The unpublished working tree is based on 2.2.0 commit `b7717b4`. No commit, staging, push, tag or publication
is part of this local closeout.

The **22 October 2026 document-scope acceptance was taken on an intermediate tree**. Its measurements and
package identities below remain historical evidence and are **superseded for release acceptance by the combined run**.
The [combined acceptance of 27 October 2026](#combined-acceptance-of-27-october-2026-accepted-locally) is that
single complete acceptance of the final unchanged product tree, covering R23 and R24 together and bound to both frozen
VSIX hashes. Fixed budgets, assertions, timeouts and gates remained unchanged throughout.

## Implementation and combined acceptance plan

- [x] Define the bounded document/history API, linked transactions, recovery and field-maintenance changes.
- [x] Complete the separate official modern/classic ABI probe and require the explicit adapter boundary.
- [x] Implement the exact hosted-service registry, bounded kernel/editor/adorner contracts and proven Lane B Reset.
- [x] Prepare SDK 0.1.0, independently built action/editor samples, verified package loading and hash-bound development grants.
- [x] Retain the intermediate document acceptance, hosted-service checks, verification corrections and their boundaries.
- [x] Rerun the full minimum-version Extension Host precheck, unchanged S016/S122 budgets and S003 hot-exit restore; all pass.
- [x] Run every executable CI step on the combined final tree, including both supported hosts and installed upgrade/downgrade legs.
- [x] Freeze both 2.3.0 VSIX files, retain normalized artifact-bound evidence for both task groups and verify every evidence gate.
- [x] Reconcile the combined ledger and roadmap only after that complete acceptance passes.

## Acceptance ledger

Every row below is **PASS on the combined final tree**: the 27 October 2026 run executed the listed suites on that tree,
and the [combined evidence index](release-2.3.0/combined-evidence-index.json) binds their reports to it. The detail
column names the evidence each task relies on; earlier measurements were not promoted by renaming the product.

### Documents, history and recovery (R23)

| Task | Required outcome | Combined verdict and evidence |
|---|---|---|
| R23-01 | Separate disk, unsaved document, journal and preview ownership; public API probe | PASS — both full two-launch history reports; native/editor-stack separation, checkpoint mismatch refusal and explicit Reload probes |
| R23-02 | Common host transaction orchestration for source and linked artifacts | PASS — `runPatchSetTransaction`, live and recovered source-image scopes; transaction/resource suites and ordinary product regression |
| R23-03 | Up to 20 verified logical operations and explicit native history limits | PASS — both full history reports: 20-operation cap, 21 live Undo/Redo, saved suffix and retained prior redo branch; public native-import limit below |
| R23-04 | Linked event, resource, image and Save As recovery | PASS — both engines: linked handler/image/neutral and culture resources, evicted-handler checkpoints and exact saved bytes; Save As unit/fault cases |
| R23-05 | Affected-file conflict actions without overwriting external bytes | PASS — two actual external source edits and explicit Reload cycles per engine, dirty-code refusal, timeline/diff/export and foreign-byte recovery tests |
| R23-06 | Safe Save As paths, collisions, open buffers and documented rename boundary | PASS — `formSaveAs.test.ts`, local path and R23 transaction suites: collisions, casing, open buffers, snapshot movement and linked cultures; bounded rename below |
| R23-07 | Redacted recent operations, failures and restore points | PASS — `recoveryTimeline.test.ts`, both host history reports and redacted diagnostics; recent outcomes contain no source text |
| R23-08 | Crash phases, failed writes, cancellation and concurrent changes | PASS — real subprocess-stop recovery legs plus transaction/resource fault injection; unacknowledged physical writes remain manual decisions |
| R23-09 | Explicit project choice and fresh membership validation on two net48 owners | PASS — full Extension Host owner fixture on both VS Code versions: two built net48 owners, selected DLL/root value, cancellation/stale choice and event-source scope |
| R23-10 | Bounded discovery finds owner controls beyond nested/native assembly noise | PASS — bounded nested/native/satellite/owner-priority discovery tests and executable scanner tests on both engines; no constructors or entry points executed |
| R23-11 | Framework fast path and SDK-specific unsupported-query caching | PASS — 16 evaluation-policy tests plus actual SDK 6.0.407/MSBuild 17.3.2 output-resolution report; custom TargetPath and preview limits below |
| R23-12 | Intentional lifecycle exit reasons in logs and diagnostics | PASS — each full history report opens eight owners under capacity four and records `budgetRecycle intentional=true`; lifecycle/transport/diagnostic suites |

### Hosted services and Adapter SDK Preview (R24)

| Task | Required evidence | Combined verdict and evidence |
|---|---|---|
| R24-01 | Exact methods and STA/lifetime/cancel/reentrancy/refusal contracts for all named service families | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |
| R24-02 | Real calls of the new kernel services from product UI on modern and net48 | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |
| R24-03 | Versioned schema/types/capabilities/package layout, action and editor samples, matrix and diagnostics | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |
| R24-04 | Actual package bytes, hashes, provenance policy, cohort and trust checked before execution and mutation | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |
| R24-05 | Explicit hash-bound local development enablement, persisted consent and immediate revocation | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |
| R24-06 | Declared editor UI ownership/focus/Escape/Cancel/deadline/nesting/result type/invariant behavior | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |
| R24-07 | Stable action identity, keyboard route, disabled reasons and sole transaction authority | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |
| R24-08 | A bounded operation with independent semantic and exact preservation postconditions | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |
| R24-09 | Independently built samples pass public-surface success/refusal/cancel/undo/restart | PASS — 30/30 public adapter scenarios on each supported host ([1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json), [stable](release-2.3.0/combined-adapter-host-stable.json)) plus engine and SDK contract suites |

## Combined attempt of 23 October 2026: blocked (retained verification correction)

The [combined attempt report](release-2.3.0/combined-blocker.json) records **BLOCKED**, not RELEASE_READY.
The complete run started at **2026-10-23T06:18:45.342Z** on 667 frozen input hashes. The [CI attempt](release-2.3.0/combined-ci-attempt.json)
retains its original inputs, commands, script/log hashes and results: modern build PASS, net48 x64 build PASS,
modern tests **797/797** with zero failures/skips, then net48 test restore **FAIL**. No test executed in that fourth step.
The remaining **41 of 45 executable steps were NOT EXECUTED**. No combined-release VSIX was built or frozen,
and there are no final package SHA-256 values or artifact-bound acceptance verdicts for this attempt.

`tests/Engine.Net48.UnitTests/Engine.Net48.UnitTests.csproj` directly references `StreamJsonRpc` **2.25.29**.
The restored package metadata and assets select `MessagePack` **2.5.302** for that independent test graph. Both
product engine projects pin **2.5.303**, but that pin is absent from the test graph. Restore fails with **NU1902** for
[GHSA-qhrr-8q5h-9q3h](https://github.com/advisories/GHSA-qhrr-8q5h-9q3h). The advisory identifies 2.5.303 as patched.
The project and `Directory.Build.props` are unchanged; audit remains enabled for all dependencies at moderate severity,
with NU1902/NU1903/NU1904 treated as errors. The closeout prohibits dependency additions, removals and upgrades.
No dependency change, suppression, audit bypass or gate relaxation was applied. The maintainer must authorize a
bounded dependency correction before a new complete acceptance can run.

Before that attempt, the full minimum-version smoke passed on VS Code **1.84.0**, including **18/18 tail groups**
and a real second-launch **S003 hot-exit restore**. It ran from **2026-10-23T06:11:34.111Z** to **06:18:37.981Z**.
The [first-launch report](release-2.3.0/combined-minimum-host-precheck.json),
[restore report](release-2.3.0/combined-minimum-host-precheck-s003.json) and
[S122 product performance report](release-2.3.0/combined-performance-precheck.json) retain the actual observations.

| Fresh minimum-host precheck | Modern | net48 | Unchanged budget |
|---|---:|---:|---:|
| S016 initial readiness | 4217 ms | 4029 ms | 6500 ms |
| S016 commit and reconciliation | 484 ms | 643 ms | 1000 ms |
| S122 standard-300 first use 1: plan+commit / reconciliation | — | 494 / 127 ms | 750 ms per phase |
| S122 standard-300 first use 2: plan+commit / reconciliation | — | 338 / 127 ms | 750 ms per phase |
| S122 standard-300 first use 3: plan+commit / reconciliation | — | 387 / 113 ms | 750 ms per phase |

The earlier performance failure did not recur in this precheck. Comparison with `b7717b4` confirms that the
net48 retained-graph lifetime and render worker are unchanged. A historical failed trace proves a missing cached
graph caused full re-interpretation; its removal cause and a single CPU/I/O explanation remain unproved. No product
performance fix or budget/assertion/timeout change was made. This precheck does not replace either supported-host
smoke in the halted full run, the R23/R24 acceptance suites or installed-package acceptance.

All new reports are explicitly diagnostic and have no VSIX acceptance binding. Their raw and normalized hashes are
retained in the attempt report; scratch paths are normalized to `<ci-temp>`, test workspaces to `<test-temp>` and
checkout paths to `<repo>`. Existing 22 October JSON and package identities remain historical and unchanged.
The changelog remains undated (`Unreleased`) because no combined acceptance date exists. R24 roadmap checkboxes
and the combined local-acceptance status remain pending.

## Authorized test-graph correction and exact CI preflight (23 October 2026; retained verification correction)

The maintainer authorized the net48 test graph to select **MessagePack 2.5.303**, matching both product engines.
That explicit pin in `tests/Engine.Net48.UnitTests/Engine.Net48.UnitTests.csproj` was already applied before this
run. The RPC dependency remains unchanged, as do the all-dependency, moderate-severity NuGet audit and its
error policy. No additional dependency change was made. The preceding NU1902 attempt and its reports remain
unchanged as a retained verification correction and do not count toward acceptance.

The [fresh exact-command preflight report](release-2.3.0/combined-preflight-blocker.json) captures **667 input
hashes**, including the corrected test project. Before starting the long acceptance suites, the required
`npm run release:preflight` command from executable CI step **17 of 45** ran without added options. It failed
with exit code **1**: **release worktree must be clean; found 173 changed paths**. This was its only reported
failure. Input hashes, Git status and the index remained unchanged during that check.

This is an early diagnostic precheck, not an ordered full acceptance run: **0 PASS, 1 FAIL, 44 NOT EXECUTED**,
with no test execution. The report includes the complete workflow inventory, per-step verdicts, exact command
and log hashes. It is diagnostic evidence with no VSIX acceptance binding. No combined-release package was
built or frozen. Earlier tests, host prechecks and intermediate packages do not supply missing results.

The default preflight checks Git cleanliness; this retained diagnostic preceded the maintainer's
24 October decision to use `npm run release:preflight -- --metadata-only` for local acceptance. The earlier
clean-worktree failure is therefore no longer a local blocker. Its reports remain unchanged and do not count
toward acceptance. No gate, assertion, budget, timeout or audit policy was changed.

## Combined attempt of 24 October 2026: dependency audit blocked

For local acceptance, the release preflight runs in metadata-only mode: clean-tree and tag identity are
checked on the CI checkout of the release commit. Git cleanliness and tag identity are **NOT ASSERTED**
locally. This is the sole permitted local substitution in the current [CI definition](../.github/workflows/ci.yml).
The ordered attempt stopped before that preflight step; metadata preflight is **NOT EXECUTED** in this run.

The [dependency-audit blocker](release-2.3.0/combined-audit-blocker.json) and
[complete CI attempt inventory](release-2.3.0/combined-audit-ci-attempt.json) record **8 PASS, 1 FAIL and
36 NOT EXECUTED** across all 45 executable steps, from **2026-10-24T15:49:30.161Z** to **2026-10-24T15:51:44.892Z**,
on **667 unchanged input hashes**, including the authorized net48 MessagePack 2.5.303 pin.

- Both Release engine builds: PASS. Modern xUnit: **797/797**; net48 xUnit: **89/89**, no failures or skips.
- Archived Visual Studio reference renders: PASS; all three compared renders met their unchanged thresholds.
- Source coverage: **32/35 (91.43%)**, above the unchanged **80%** gate. All six sample-fixture build commands passed.
- Extension dependency installation: PASS. The following unchanged audit step exhausted all **three** CI attempts
  at npm audit --audit-level=moderate and exited **1**, with **2 vulnerable packages (1 moderate, 1 high)**.

The public dependency graph selects development dependency **jsdom 29.1.1**, which uses the existing
**undici 7.29.1** override in extension/package.json. The lockfile and installed dependency explanation
confirm that exact version. The audit names [GHSA-4qv8-2p9j-2685](https://github.com/nodejs/undici/security/advisories/GHSA-4qv8-2p9j-2685),
[GHSA-f72v-6w45-q472](https://github.com/nodejs/undici/security/advisories/GHSA-f72v-6w45-q472) and
[GHSA-xjj6-f33q-929c](https://github.com/nodejs/undici/security/advisories/GHSA-xjj6-f33q-929c).
The upstream advisories identify **7.30.1** as the patched 7.x version. A further dependency correction is
outside the authorized scope. No dependency change, audit bypass or assertion, budget, timeout or gate
relaxation was applied. Acceptance stops here pending a maintainer decision on that bounded correction.

An earlier attempt in the same run stopped before net48 test discovery because its shadow-copy cache path
was too long. The [retained environment correction](release-2.3.0/combined-temporary-path-correction.json)
records a controlled assembly-loader probe: the same adapter failed through the long cache path, loaded
through a short drive alias to the same directory, then failed again through the long path. A fresh full-acceptance
run used the alias for temporary paths, with every file still inside the authorized scratch directory; the alias
was removed afterward. No product, dependency or test-configuration change was needed. Its earlier **3 PASS,
1 FAIL and 41 NOT EXECUTED** do not count toward the later attempt.

These are diagnostic reports with raw and normalized SHA-256 identities and **no VSIX acceptance binding**.
No combined-release package was built or frozen. Release Extension Host suites, installed upgrade/downgrade,
strict localization, mojibake scanning, remaining evidence validators and CI mutation self-tests were not reached.
The 23 October failed attempts and all intermediate evidence remain retained and do not supply missing results.
The 2.3.0 changelog remains undated, R24-01–R24-09 remain unchecked and both roadmap acceptance fields remain pending.

## Authorized development-test dependency correction and fresh attempt (26 October 2026)

The maintainer authorized the existing development-test override to select **undici 7.30.1** instead of
7.29.1, with only the corresponding lockfile version, resolved archive and integrity entry changed.
This correction was already applied before this attempt. It belongs to the **jsdom development-only test
graph** and does not affect the shipped VSIX payload; no product dependency changed. The preceding
MessagePack 2.5.303 test-graph pin remains in place. No additional dependency change is authorized or applied.
The 24 October audit attempt and its environment correction remain retained verification corrections,
excluded from acceptance. Their former dependency-change authorization blocker has been resolved by this pin;
the fresh audit still has to run.

An earlier 26 October attempt passed steps 1–28 and was inside step 29, the minimum-version Extension Host
smoke, when an execution-session infrastructure failure interrupted it and its runner was terminated.
This was **not a product failure**. Nothing in that attempt changed the working tree; none of its results
counts toward acceptance, and no missing result is inferred from its partial smoke output.

The fresh run restarted from step 1 at **2026-10-26T08:03:35.618Z** and stopped at **2026-10-26T08:07:24.201Z**.
The [installation blocker](release-2.3.0/combined-install-blocker.json) and
[complete CI attempt inventory](release-2.3.0/combined-install-ci-attempt.json) record **7 PASS, 1 FAIL and
37 NOT EXECUTED**, on **667 unchanged input hashes** matching the interrupted attempt.

- Both Release engine builds: PASS. Modern xUnit: **797/797**; net48 xUnit: **89/89**, zero failures or skips.
- Archived Visual Studio reference renders: PASS for all three comparisons. Coverage: **32/35 (91.43%)**
  against the unchanged **80%** minimum. All six sample-fixture build commands passed.
- Step **8 of 45**, unchanged **npm ci**: FAIL, exit **1**. The final error was a read **ECONNRESET** while
  fetching registry metadata for xmlchars. The original npm log records three failed fetch attempts each
  for xmlchars and why-is-node-running. The logs establish connection resets, without identifying whether
  the registry, an intermediary or the local connection terminated them. No product defect is proved.
- Steps **9–45**, including dependency audit, both supported-host smoke and release suites, installed
  upgrade/downgrade, evidence validators and mutation self-tests, strict localization, mojibake and
  packaging: **NOT EXECUTED**. No combined-release VSIX was built or frozen; no final package hash exists.

The metadata-only local preflight remains the sole authorized CI substitution. It was prepared but not
reached; Git cleanliness and tag identity remain **NOT ASSERTED** locally and are checked on CI's release
commit checkout. The short temporary-path alias avoided the known net48 loader issue; all temporary files
were physically inside this attempt's scratch directory, and the alias was removed after execution.

Acceptance stops at this external installation failure under the unchanged stop rule. No product,
dependency, workflow, audit policy, assertion, budget, timeout or gate changed. The failed installation may
leave the ignored node_modules directory incomplete; a later fresh installation must complete before use.
The new reports are diagnostic, with separate raw and normalized report/script/log SHA-256 bindings and
**no VSIX acceptance binding**. Earlier results do not supply missing steps. The changelog remains
**Unreleased**, R24-01–R24-09 remain unchecked and both roadmap acceptance fields remain pending.

## Combined acceptance of 27 October 2026: accepted locally

Registry access was healthy again after the installation attempt: `npm ci` and a zero-vulnerability audit passed on
the first try. The attempts below led to the final run; only the final run counts toward acceptance.

**A product regression found and fixed (retained attempt, not counted).** The next complete run passed steps 1–32,
including both supported-host smokes and Release 2.2 ordinary acceptance on both versions. It then failed step 33,
Release 2.3 history and hot exit on VS Code 1.84.0: `R23-HOST-restore-net48-linked` reported *Reload left ordinary
designer editing blocked*. The failure reproduced in isolation.

One save of the code-behind file reaches the file watcher as several change notifications, the later ones up to
hundreds of milliseconds afterwards. A late notification arrived after the explicit Reload had started its render.
The session treated it as a code-behind change, invalidated that render's generation and kept the designer read-only,
so the next property edit was refused. The refusal was fail-closed and wrote nothing.

The session now remembers the code-behind text it last invalidated the render for. A file notification is ignored
only while the open code-behind buffer, dirty or clean, still holds exactly that text: the render reads that buffer,
and VS Code reports a clean buffer's reload from disk as a text change, which still invalidates. A closed code-behind
file or different text invalidates as before. A first, narrower version that covered only clean buffers still failed
three of three runs, because a notification during a dirty interval cleared the remembered text. The final version
passed three of three runs on 1.84.0 and one on stable. No assertion, timeout or budget changed.

**A complete run before the changelog was dated (superseded).** It passed **45/45** from 10:32 to 11:12 UTC. Dating the
2.3.0 changelog section and adding the fix entry then changed packaged bytes, so that run does not bind the final packages.

**Environment attempts (retained, not counted).** A run whose temporary directory was placed on a rotational disk
timed out one file-system-heavy extension unit test at step 20 (25.4 s against the unchanged 20 s limit); temporary I/O
moved back to a solid-state disk. One later run failed step 31 in `R22-HOST-014-net48-repeated-crash-stops-automatic-recovery`:
a just-started replacement worker had not settled a request when the test captured worker sessions. The test had been
unchanged since 2.2.0, and the same suite passed three of three runs in isolation. This was a timing race in the test,
not a product failure.

**Repeated-crash acceptance waits for the replacement worker (test change).** The next complete run passed **45/45**
(`combined23-6a438c50-edda-4a68-bad6-84815f8d18fe`, 2026-10-26T11:51–12:23Z). The acceptance suite was then corrected:
before it captures worker sessions, `R22-HOST-014` now waits, within the suite's existing 60-second bound, until every
running worker of the kind has settled an audited request, and then waits for idle again. Its crash, replacement and
crash-loop assertions are unchanged, and the product is unchanged. The suite passed four of four runs (three on 1.84.0,
one on stable). Because the suite is an acceptance input, that earlier passing run is superseded; its retained evidence
was replaced by the final run below.

**Final acceptance run.** Run `combined23-467d3cef-14d1-449e-8250-4a743dc96f91`, from **2026-10-27T03:11:26.692Z** to
**03:45:19.940Z**: all **45 executable steps** exited 0, and the **667 frozen inputs** were unchanged throughout. The tree is
intentionally uncommitted over `b7717b4`. Temporary paths were a short local directory; no drive alias was used.

- Engine suites: modern **797/797**, .NET Framework **89/89**; extension **931/931** in 75 suites, 0 pending.
- Headless end-to-end: PASS. Webview: **1029 checks across 218 tests**, 0 failed.
- Archived Visual Studio reference renders, coverage **32/35 (91.43%)** against the unchanged 80% gate, generated
  protocol, measured scenario catalogue (**111** measured PASS), adversarial evidence controls, performance baseline and
  VSIX isolation: PASS.
- Dependency audit: **0 vulnerabilities**, with MessagePack **2.5.303** in the engines and the .NET Framework test project
  and the test-only undici **7.30.1**. Strict localization: **650 runtime and 58 package keys** in every locale.
  Mojibake scan: 830 tracked text files clean.
- Supported-host smoke with its real S003 hot-exit restart: PASS on **1.84.0** and stable **1.143.1**.
- Ordinary product acceptance **28/28** on each host — [1.84.0](release-2.3.0/combined-ordinary-host-1.84.0.json),
  [stable](release-2.3.0/combined-ordinary-host-stable.json).
- R23 history acceptance **25/25** on each host (15 setup, 10 restore, two real launches) —
  [1.84.0](release-2.3.0/combined-history-host-1.84.0.json), [stable](release-2.3.0/combined-history-host-stable.json).
- R24 public adapter acceptance **30/30** on each host (6 setup, 24 restore, two real ordinary hosts, the independently
  built samples and read-only workspace-grant receipts) — [1.84.0](release-2.3.0/combined-adapter-host-1.84.0.json),
  [stable](release-2.3.0/combined-adapter-host-stable.json).
- Installed reconstructed **2.1.0 → 2.3.0 → 2.1.0**: all three host phases PASS on 1.84.0 and 1.143.1, installing the
  exact frozen x64 VSIX — [1.84.0](release-2.3.0/combined-upgrade-downgrade-1.84.0.json),
  [1.143.1](release-2.3.0/combined-upgrade-downgrade-1.143.1.json).

| Final-run performance (ms) | 1.84.0 modern | 1.84.0 net48 | stable modern | stable net48 | Unchanged budget |
|---|---:|---:|---:|---:|---:|
| S016 initial readiness | 3869 | 3816 | 3705 | 3732 | 6500 |
| S016 commit and reconciliation | 542 | 521 | 394 | 462 | 1000 |
| S122 standard-300 first use 1: plan+commit / reconciliation | 78 / 85 | 372 / 91 | 62 / 74 | 338 / 71 | 750 per phase |
| S122 standard-300 first use 2: plan+commit / reconciliation | 79 / 90 | 283 / 77 | 63 / 81 | 266 / 90 | 750 per phase |
| S122 standard-300 first use 3: plan+commit / reconciliation | 115 / 73 | 300 / 91 | 62 / 77 | 280 / 87 | 750 per phase |

| Frozen package | Modern RID / PE | .NET Framework PE | VSIX bytes | VSIX SHA-256 |
|---|---|---|---:|---|
| Windows x64 | win-x64 / 0x8664 | 0x8664 | 18,405,725 | `628ff96db940a6fdec94b860ec522e74eeb254da5fab3cbcd73949e8751b1e48` |
| Windows ARM64 | win-arm64 / 0xAA64 | 0x8664 | 18,393,519 | `48add7608d9eaf3a3431c3fda940b57bfe8c1f1a2f40108ad5993cc3347bd68a` |

Both packages carry version **2.3.0**, engine assembly versions **2.3.0.0**, the same extension bundle and the same
x64 .NET Framework engine, with acceptance suites, the independent samples and the official SDK reference absent.
The [package inspection](release-2.3.0/combined-packages.json) hashes every entry. Packaged manifest, license, notices,
README and bundle bytes equal the checkout. The packaging tool links bare issue numbers in the changelog; the
inspection applies exactly that rewrite to the source changelog and requires byte equality.

The [combined evidence index](release-2.3.0/combined-evidence-index.json) binds **82 retained reports**, all 45 CI logs,
the 667 input hashes and both package hashes, with separate raw and retained SHA-256 values. Retained text normalizes only
repository, CI-temporary, test-temporary and user-profile path prefixes. The index binding refused all **9** mutation
controls, and the normal-host evidence validator refused all **25** negative controls.

The local preflight ran as `npm run release:preflight -- --metadata-only`, the sole local substitution. Git cleanliness
and tag identity are **NOT ASSERTED** locally; CI checks them on the release commit.

**After local acceptance.** The first CI run on the release commit failed one minimum-version smoke scenario,
`V2-FND-001-S104`: its final check that every observed engine PID has left the operating system timed out, after the
product had already reported zero live engine processes. The observed set includes PIDs of workers replaced in earlier
cycles, and a shared runner can give such a number to an unrelated, newer process. The suite now treats a PID held by a
process created after it was first observed as exited, and allows 30 s instead of 10 s for teardown. The product is
unchanged; the smoke passed **18/18** on 1.84.0 and stable locally. This acceptance-suite change postdates the retained
local evidence, so that one test file's input hash differs from the index; the complete check of the final tree is the
CI run on the commit that contains it.

## Document and history contract

The generated-source buffer, the last saved byte image, linked artifacts, durable transaction records and the
rendered preview have separate authority. A backup keeps the exact source bytes readable by earlier versions;
an optional `.history.json` sidecar carries verified operations and checkpoints. It contains data rather than
callbacks, worker objects or vendor graphs. Invalid metadata cannot silently replace the last source image.

The generated-source dirty indicator compares its current and saved bytes. A resource-only write keeps that
source clean. A separate recovery decision includes unsaved linked code buffers and pending logical history,
so resource Undo and requested hot-exit backups are retained without inventing an unsaved source change.

Transaction-owned source writes carry their exact before/after text and BOM images through write, compensation
and model adoption. The file watcher also checks a read epoch and the document revision after asynchronous IO.
It defers only exact owned images and schedules a fresh read when the scope ends; unrelated external bytes
still produce a conflict. The two-launch acceptance repeats two external-edit/Reload cycles after a resource-only
change on each engine, including recovered native Redo from the clean checkpoint.

Aggregate Save waits for all linked baseline reads and saves an owned ordinary code buffer through the public
TextDocument API before flushing generated source. Missing or changed companions do not establish a checkpoint.

History retains at most **20 operations** and a **16 MiB operation-data budget**. A separate **8 MiB editor-checkpoint
budget** preserves the current code-behind image even when its creating operation has been evicted; the
complete metadata backup is bounded at **64 MiB**. Exceeding a complete-backup limit refuses the backup
visibly and preserves the live buffers. Removing old operations
advances the retained base image. The current source remains recoverable when an older operation exceeds
the retained range. A still-live native callback crossing that boundary rebases the durable history; an
explicit Save establishes the next clean checkpoint. Applied operations, the active cursor, the saved checkpoint and an existing redo branch
are explicit fields of the durable format.

The [public Custom Editor API](https://code.visualstudio.com/api/extension-guides/custom-editors) exposes
edit events with undo/redo callbacks. It does not expose an import operation for the native saved index or a
pre-existing native redo stack. For histories containing only generated source and disk artifacts, reopening restores the applied suffix
after the last matching checkpoint as native Undo. Undo after restoration creates a normal native Redo.
A restored history containing ordinary editor artifacts uses the public Undo/Redo Recovered Action commands;
the designer keyboard shortcuts route through those actions. Direct native Undo in the ordinary code editor
still has its own stack and can change the handler buffer alone. The implementation must detect that exact
checkpoint mismatch before aggregate save, replay or a new designer mutation, preserve current bytes and
require reconciliation. The acceptance probe records the separate native transition, its refusal boundary,
and exact native Redo restoration before testing the composite actions. The public API cannot clear or import
the ordinary editor stack. A previous redo branch remains validated recovery data; native replay of that branch
and the prefix before a saved checkpoint are limited. Multiple CustomEditor views remain disabled.

Explicit Reload reaches the public provider Revert even when the custom model was clean, then clears its
old history baseline. It preserves the current saved main-code bytes. An unsaved main-code buffer refuses
Reload before any reset: save or undo that code first. A pending transaction recovery decision remains latched.

Workbench-clean custom documents do not request a VS Code hot-exit backup. Saving marks a checkpoint, and a subsequent dirty
backup carries that checkpoint with its later operations. A clean-only native stack is not promised across
processes. The real launch probes confirm the supported subset on both VS Code versions.

## Save As and discovery boundaries

Save As remains a create-only aggregate operation. It must refuse case-insensitive collisions, changed
baselines and open conflicting buffers before writing companions. It keeps the namespace and applies only
the supported bounded form type rename; general semantic refactoring is deferred to R29-06.

Automatic toolbox discovery accepts managed `.dll` and `.exe` outputs. Native apphost EXE images and satellite
resource assemblies are filtered before the 24-assembly reflection budget. Owner and ProjectReference output
names take priority. The manual Choose Items assembly picker retains its existing DLL surface. Discovery
details are bounded at 256 records, with an omitted count.

Automatic replay owns the form main source, generated partner and its neutral/culture resources. Alternate
event partials and project edits remain available for a manual ownership decision. Serialized metadata does
not recreate engine authorization for dirty localizable event source.

A physical write interrupted before its durable acknowledgement has an explicit manual recovery result,
with all current bytes and the journal retained. A matching after-image hash alone cannot prove which process
wrote it. Permission, disk-full and cancellation cases are fault injection; physical storage-failure
qualification is not implied.

An explicit assembly override remains authoritative and is disclosed alongside a chosen project context.
The selected project controls automatic output resolution and event-source membership.

## Scope and evidence rules

The existing v2 manifest registry remains a compatibility declaration. Its JSON signature label cannot grant
execution or mutation authority. A separate loader must inspect the real package and apply the chosen trust policy.
Worker/process isolation is a lifecycle boundary, not an OS security sandbox.

The modern ABI probe and classic System.Design probe are separate from the product's own adapter samples. A
reference assembly or an unsupported native UI path cannot be reported as a working redistributable designer host.
No undocumented Visual Studio or DesignToolsServer protocol is a fallback under ADR 0003.

Product source or payload changes invalidate their previous acceptance identity. Final results and package hashes
remain pending until implementation is frozen and the complete required check set has run.

## Hosted-service verification corrections retained

The first complete-check attempt reached the minimum-version Extension Host smoke and exposed a compatibility
regression: the new nine-service Preview registry had leaked into the existing six-requirement v1 certificate.
Both legacy brokers now project the original exact six requirements from their actual session, with independent
modern/net48 tests; the existing product identity checks and Extension Host assertions retain their original contract.
The original failed attempt is preserved and does not count toward final acceptance.

A later boundary audit reproduced four malformed UTF-8 acceptances: a manifest display name, a real child String
intent, and correctly hashed entry/dependency modules. Fatal decoding now refuses those bytes before admission or
mutation; a real encoded U+FFFD and valid Unicode remain accepted, and the existing JSON BOM refusal is preserved.
The second check attempt finished its 29th step successfully and then stopped on the source-hash guard because this
correction changed three inputs. Its incomplete results do not substitute for a separate full unchanged-tree run.

## Hosted-service acceptance attempts and performance measurements

The preceding hosted-service check attempts passed 797 modern, 89 net48 and 931 extension unit tests, 12 independent SDK tests,
strict public types, headless product e2e and 1029 webview checks. Public SDK acceptance passes 30/30 groups in both
VS Code 1.84.0 and 1.143.0, with separate real setup/restore hosts and SQLite grant receipts. Installed-package and
archive acceptance had not completed on that tree; these prior results alone do not close the combined release.

An earlier unchanged-input minimum-version smoke passed 16 of its 18 tail groups but failed the fixed S016/S122
performance budgets. Focused reruns measured modern initial readiness 9645 ms against 6500 ms and standard-300 net48
first-use reconciliation 930 ms against 750 ms. All observed engine RPCs succeeded. Preparation, compatibility and
capture phases contributed to the delay under concurrent load; an adapter regression or a single CPU/I/O cause was
not proved. A later unchanged-input minimum-version rerun passed all 18 tail groups and S003 restore: modern initial
readiness was 4443 ms, net48 initial readiness 4399 ms and standard-300 net48 first-use reconciliation 687 ms. The
following stable-host smoke also passed all 18 groups and S003 restore. These measurements resolve neither the cause
of the earlier failures nor acceptance of the newly combined product bytes. The combined final-tree run must pass
the same unchanged budgets and assertions on both supported hosts.

## Public Preview boundary

The independent [SDK package](../adapter-sdk/README.md) is version **0.1.0**, with protocol **1** and product cohort
**2.3.x**. It admits exactly `action.set-property` and `editor.scalar`: one typed `setProperty` proposal for an editable,
owned, nonlocalized String, Boolean or Int32 property. Inherited/read-only properties, enums, arbitrary objects,
resource edits and source patches are outside this adapter mutation profile. An explicit editor input and the
returned dropdown value must both belong to the declared choice list. Unknown getter metadata is refused.

The loader verifies the manifest and every real declared file, physical path, hash, provenance policy, product/runtime/
architecture cohort and required service before launching an isolated stdio process. The current executable policy
is explicit **trusted local development**, certification **none**. Workspace consent is bound to the exact package
SHA-256; changed content requires acknowledgement again. A JSON signature label grants no rights. This code executes
with the author's OS privileges; the process and import boundaries are not a security sandbox.

The host binds every result to the actual open document instance, revision, source image, property metadata, runtime,
architecture and service profile. It rechecks the physical package and the live grant immediately before its sole
source commit. Revocation aborts pending children and removes published actions. A replacement document with the same
path/text cannot accept an old result. A child has at most 5 seconds of execution plus a separate 5-second termination
confirmation bound; unconfirmed cleanup refuses and retains the live child's physical admission until close.

The service profile **0.1.0** lists nine exact contracts: `ContainerSiting`, `Naming`, `ComponentChange`, `Selection`,
`Transactions`, `MenuCommands`, `ToolboxCatalog`, `TypeResolution` and `PropertySerialization`. The new toolbox creates
only Button, Label, Panel and TextBox through the existing design host. Type resolution uses already loaded permitted
assemblies; it does not probe or load another graph. Property serialization captures Text/Size snapshots for 1–16
owned exact framework controls and reads bounded invariant proposals; it never writes source/resources or serializes
an arbitrary vendor graph. The public inspection calls these services on an actual disposable STA graph on each
engine and withholds an incomplete host. Classic `IDesignerSerializationService` remains an explicit refusal.

The existing `repo.fakevendor.hosted-service-kernel.v1` result retains exactly its six certified core requirements.
Both legacy brokers project only requirements actually present in their session; Preview-only services do not alter
that certificate. The underlying session still requires the full nine-service kernel before advertising its aggregate
host. The new Preview profile is inspected separately, with its own explicit version and method inventory.

Input and dropdown editors use the workbench-owned UI with one invocation per document, focus ownership, Escape,
cancellation, a 30-second presentation deadline and strict type/invariant checks. Undeclared native WinForms windows
remain refused. Canvas Tasks entries publish data-only stable identities, the same pointer/Enter/Space command,
disabled reasons and exact generation/revision/selection bindings. Render-only adorners gain no mutation authority.

The new Lane B operation is a single owned scalar Reset. Its independent postconditions require an actual source-first
reset, complete before/after IR, the exact target assignment removal and byte-for-byte ordered preservation of every
other statement and of the source outside the owned body. Its result must equal the independently produced Lane A
bytes. Ambiguous input falls back to the existing safe targeted route or refuses. Localized Reset retains its ordinary
resource transaction; the public adapter Reset automation command is restricted to nonlocalized owned properties.

## ABI decision and external gates

The independent [modern/classic ABI probe](adapter-sdk/abi-probe.md) requires **EXPLICIT_ADAPTER_REQUIRED**. The official
Microsoft Designer SDK 1.6.0 package supplies reference metadata; its modern server reference refuses ordinary runtime
loading with `BadImageFormatException` 0x80131058. No private Visual Studio/DesignToolsServer protocol or implementation
redistributable is used. The classic sample activates a real public `System.Design.DesignSurface`, executes a
transactional action and observes the named headless refusal of native editor UI. These probes do not certify an
existing vendor binary. Their exact package/API/source/assembly identities are separate from the two SDK samples.

The first licensed vendor cohort, physical ARM64/native UI acceptance and Marketplace/Open VSX/npm publication remain
**NOT EXECUTED / GATED** according to their own scope. They are not inferred from local sample, RID or ABI results.

## Intermediate document-scope acceptance (22 October 2026; superseded)

At the time, all **38 executable steps** of the then-current [CI definition](../.github/workflows/ci.yml) had final exit code 0
on the same unchanged intermediate document-scope tree. The local run started at **2026-10-22T13:30:31.810Z** and
finished at **2026-10-22T14:07:10.723Z**, over commit `b7717b4b4828ab08f390c622d12211ed0ed79729` in an intentionally uncommitted working tree.
The existing [CI report](release-2.3.0/ci-checks.json) and [evidence index](release-2.3.0/evidence-index.json)
retain that intermediate run; the combined run's evidence is retained separately under `combined-*` names. The historical measurements
and package hashes below are superseded for combined acceptance; none proves the later hosted-services tree.

Packaging step 33 first refused the audited 2.5.303 payload because its version pin and isolation fixture still
expected 2.5.302. Only those two packaging-validation scripts changed after product acceptance; their before/after
hashes are retained. Isolation step 13 and package step 33 were rerun, including rejection of the old dependency,
then steps 34–38 completed. The original attempts remain in the CI report. Product, acceptance and binary hashes
did not change; this is a complete check set with explicit gate revalidation, not a single uninterrupted run.

- Modern engine: **729/729**, .NET Framework engine: **65/65**; no failures or skipped tests.
- Extension unit/integration layer: **775/775**, 0 failed and 0 pending.
- Headless end-to-end with net48 required: PASS. Webview: **997 checks across 214 tests**, 0 failed.
- Archived Visual Studio reference renders, **32/35 (91.43%)** coverage against the unchanged 80% gate, generated protocol,
  static/measured scenario catalogue, adversarial evidence controls, performance baseline and VSIX isolation: PASS.
- Strict localization: **629 runtime keys / 51 package keys** in all locales. Dependency audit: **0 vulnerabilities**.
- Full ordinary Extension Host smoke and its real S003 hot-exit restart: PASS on both versions; the measured scenario gate
  validates the exact same-run inputs indexed in [scenario inputs](release-2.3.0/scenario-inputs-summary.json).
- Ordinary product acceptance: **28/28** each — [1.84.0](release-2.3.0/ordinary-host-1.84.0.json), [1.143.0](release-2.3.0/ordinary-host-stable.json).
- R23 acceptance: **25/25** each across **two real launches**, with **10 actual VS Code-owned backups** per version — [1.84.0](release-2.3.0/history-host-1.84.0.json), [1.143.0](release-2.3.0/history-host-stable.json).
  It includes both engines, 21 live Undo/Redo operations, Save/Save All/auto-save, saved checkpoints, an existing redo branch,
  linked main-code/resource/image changes, the evicted handler checkpoint and repeated external-edit/Reload cycles.
- Installed reconstructed **2.1.0 → 2.3.0 → 2.1.0**: PASS with **three real host phases** on each version — [1.143.0](release-2.3.0/upgrade-downgrade-1.143.0.json), [1.84.0](release-2.3.0/upgrade-downgrade-1.84.0.json).
  The new installed package is the exact frozen x64 VSIX below. Raw source backups remain readable; history sidecars and
  foreign-schema operation records retain their bytes, or a clean backup and its sidecar retire together as recorded.
- Actual pinned old SDK: [6.0.407 / MSBuild 17.3.2](release-2.3.0/old-sdk-output-resolution.json), output resolution PASS.

The full history reports verify the same nine tested file hashes after both launches. Retention checks those hashes
again after packaging and checks the installed x64 package and bundle against the frozen artifact. Retained JSON
replaces only repository, CI-temporary and test-temporary absolute path prefixes; the index records raw and retained hashes.

## Intermediate document-scope packages (superseded)

The intermediate document-scope VSIX files passed `scripts/assert-vsix.ps1` after freezing and restoring the final pair. Target, RID, payload
and actual PE architecture checks passed. Both carry version **2.3.0**, engine assembly versions **2.3.0.0**, the
same extension bundle and the same x64 .NET Framework engine. Acceptance suites are absent from the packages.
The existing [packages.json](release-2.3.0/packages.json) records their payload and architecture results; the combined
packages are recorded in [combined-packages.json](release-2.3.0/combined-packages.json). The hashes in this historical
table do not identify the combined product.

| Modern RID | VSIX bytes | VSIX SHA-256 |
|---|---:|---|
| win-x64 | 18,359,080 | `90abe633fad8579b7bd14c22c1348fdd220048617cc07a374336ede1dc44176d` |
| win-arm64 | 18,346,871 | `583f54b6cbcca34461680832f52fc41978812a0738125a1ac1d5d407f5284a27` |

## Findings closed during intermediate document-scope acceptance

- A resource-only edit initially dirtied generated source. Source dirty now compares source bytes only; the separate
  recovery predicate retains pending resource history. Existing ordinary source/resource assertions remain enabled.
- A clean custom model could skip the stock Revert command. Explicit Reload now waits for the public provider callback
  and adopts the exact saved main-code image. Dirty main code refuses Reload before buffers or history reset.
- The watcher could discard resource-only pending history, then a recovered net48 Redo exposed an own-write race.
  Pending logical history now gates external adoption; exact before/after source images, BOM, read epoch and document
  revision guard writes and compensation until model adoption. Both engines pass the unchanged recovered native Redo
  assertions and two actual external-edit/Reload cycles, with notices offered again after the first Reload.
- Process-stop expectations now reflect the durable acknowledgement boundary: matching bytes without a recorded
  acknowledgement cannot authorize destructive compensation. All current bytes and the journal remain available.
- Approved security patches pin Vitest **4.1.12**, Vite **8.2.4** and MessagePack **2.5.303**. Audit gates remain enabled.
  The exact VSIX dependency pin and isolation fixture were updated, with an explicit old-version refusal test.

## Evidence limits and publication

The local preflight ran with **`--metadata-only`** because commits are prohibited. Clean release commit and tag
identity are **NOT ASSERTED**. The combined packages and evidence are valid only for their recorded hashes; rebuilding after
a product change or with a different embedded commit identity requires new artifact-bound evidence. The engines embed the
commit identity in their product version, so packages built from the release commit carry different engine hashes from the
ones recorded here. No commit, staging, push, tag or publication was performed.

The installed baseline is reconstructed from archived 2.1.0 sources with MessagePack 2.5.303 added only to its temporary
engine projects so the current NuGet audit can run. All **137 archived C# sources** and the audit policy retain their
hashes. This proves source-version upgrade/downgrade compatibility, not binary identity with a historical published VSIX.

The two-net48-owner fixture proves the selected compiled DLL, differing inherited root value and the exact event-source
membership snapshot; it does not qualify custom-base event wiring end to end. Old-SDK evidence proves conventional output
resolution and named unsupported-query status; it does not claim a full preview or canonical custom-output TargetPath.
The earlier unsigned `exited null` cannot be attributed retroactively. Current intentional exits are recorded explicitly;
an unrequested null exit remains abnormal.

Physical ARM64 execution, licensed vendor qualification, publication and physical storage-failure qualification remain
**NOT EXECUTED** external gates. The public native-history, additional-view, alternate-partial ownership and bounded
rename limits above remain part of the product contract; the combined run reverified them through the unchanged R23 suites.
The late code-behind notification fix is covered by the R23 linked net48 Reload scenario that exposed it; no separate
deterministic test synthesizes a delayed file-watcher notification.
