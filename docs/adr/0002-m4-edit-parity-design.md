# ADR 0002 — M4 edit parity: source-authoritative editing with canvas-bound identity

Status: accepted (design). Author: synthesized from an independent codex (gpt-5.6) architecture pass, 2026-07-20,
grounded in the current implementation. Supersedes the brief M4 scoping in ADR 0001 §11.1.

## Governing invariant

> The last successfully published canvas determines the authoritative object model for descriptions and edit
> reconciliation.

- An **interpreted** canvas is described from a freshly rebuilt interpreted graph created from the exact source/resource
  snapshot that produced that canvas.
- An **edit** against an interpreted canvas changes SOURCE first, then performs a fresh, uncached interpretation. It never
  mutates a cached interpreted object and never calls a compiled live-edit RPC.
- A **compiledFallback** canvas continues to use the cached compiled `LiveDesign` for descriptions and live mirrors —
  that instance is what the user is actually seeing.
- Dirty/clean state affects DISCLOSURE only. It does not choose the model.
- M4 starts with **no interpreted object cache**. Render and describe each own a request-local graph and dispose it
  deterministically (preserves the fail-closed teardown hardened in ADR 0001 §11).
- If interpreted description fails, the property panel becomes explicitly **unavailable** — it never silently substitutes
  compiled values underneath an interpreted canvas.

This closes all four fidelity failures (panel shows last-build values on an unsaved edit; first edit flips the canvas to
compiled; wrong siblings; wrong drag geometry) without weakening the IR / AppDomain / security model.

## Canvas authority + engine input token

Replace the weak `engineKind` + untyped `net48RenderMode` with an explicit typed `CanvasAuthority` (modernSource |
net48Interpreted | net48CompiledFallback | net48CompiledLegacy | reconciling | stale | none), each carrying an
`authorityId`, a `SourceSnapshot {text, revision (doc.rev), sourceHash}`, a `renderGeneration`, and for interpreted an
opaque **engineInputToken**. The token (computed by the engine in the DEFAULT domain, echoed to the host) covers at least:
child-domain/worker generation + normalized assembly path + logical designed type + normalized designer path + SHA-256 of
exact source text + fingerprint of the sibling `.resx` bytes actually read + viewport/client-size + DPI/culture + transient
interpreted view-state fingerprint. `doc.rev` is a host-local race gate only, not proof of engine input. `BuildId`
(mtime:length) is diagnostic assembly identity, NOT source equivalence — never used as evidence the buffer matches the
build. Remove `InterpretedRenderResult`'s silent missing-mode→compiled default (engineClient.ts:417).

**Publication gate:** `fullRender` captures `{text, rev, sourceHash}` before the engine call and installs the result only
if the render seq is current, session not disposed, `doc.rev` unchanged, `currentText()` still hashes equal, the engine
echoes the expected token, and the mode is a known typed value. Every webview message (render/layout/tray/props/itemProps/
tasks/manip) carries `authorityId`; the webview discards anything whose token ≠ the latest accepted frame.

## READ side (describe parity)

**Routing:** if the accepted canvas is interpreted, describe interpreted — dirty OR clean (not a dirty-only heuristic).
compiledFallback/legacy → cached compiled describe. A future exact build-equivalence proof (a real build-input manifest,
NOT isDirty / save-state / mtime:length) could allow compiled describe under interpreted, but the repo can't safely prove
that today, so the baseline always describes interpreted when the canvas is interpreted. Never route per-property.

**New seam:** `EngineApi.DescribeInterpretedComponent(designerFilePath, assemblyPath, sourceText, componentId, rootTypeName,
probeDirs, viewport, expectedEngineInputToken, interpretedViewState) -> InterpretedDescribeResult` (Roslyn stays in the
default domain; only serializable IR + fingerprints + id + viewport + closed view-state cross to the child). The result is
a TYPED envelope, not `ComponentDesc?`: `Outcome ∈ {ok, staleInput, coverageIncomplete, designedTypeMismatch,
executionFailed, unknownTarget, ambiguousIdentity, describeFailed}` + EngineInputToken + SourceHash + Component +
Diagnostics. `coverageIncomplete` is NOT an instruction to describe compiled.

**Child seam:** new `RenderWorker.DescribeInterpretedComponent` + `DescribeInterpretedOn` on the STA. Do NOT add a mode flag
to the compiled `DescribeOn` (identity/lifecycle differ). Extract the common interpreted construct/host/dispose into an
internal `InterpretedDesignScope` helper used by BOTH render and describe (separate request scopes; a render graph never
enters a describe cache). `AssemblyIrHost` unchanged (no Roslyn / evaluator / arbitrary method invoke / broad host).

**Describe DOES Show + layout** — parity-grade property values depend on docking/anchoring/autosize/ambient/handle
defaults/vendor PropertyDescriptors/converters/ISupportInitialize. This is the SAME compiled-code execution category the
renderer already performs; the graph still dies after the request. Do NOT site the root or add designer services.

**Target resolution** is ONLY through `IrExecutionResult.Instances` (id "" / "this" → Instances[""], else Instances[id]);
require IComponent; read origin from the same key; absent → `unknownTarget`. Never reflect the runtime root, never fall to
`GetOrCreate`, never guess from `Control.Name`. Root display name = logical `DesignedTypeName` short name (not
`root.GetType()`); direct children report the LOGICAL root as parent. `NearestFieldBackedParent` needs an interpreted
logical-root variant (reverse-resolve by reference against Instances).

**Reference-dropdown siblings** = Instances where key non-empty ∧ IComponent ∧ `Origins[key]==DeclaredInCurrentSource` ∧
valid unambiguous identity, ordinal-ordered, minus the owner; root passed separately for "(this)". Exclude Inherited
(field accessibility unknown) and internal unnamed controls. Two names → same instance ⇒ ambiguous (mark the property
read-only, don't pick). An unnameable current reference ⇒ preserve CompiledDescriber's fail-closed (no fake "(none)").
The host's anti-forgery component-ref write validation must use the SAME interpreted candidate set + token.

**Origin + editability cross the protocol:** extend `ComponentDesc`/`LayoutControl`/tray DTOs with `IdentityOrigin
{root|inherited|declaredInCurrentSource}`, `ValueAuthority {interpreted|compiled}`, `CanEdit`, `EditDisabledReason`,
`EngineInputToken`. Policy: Root/DeclaredInCurrentSource editable; **Inherited = selectable+describable but component-level
read-only** (disables property/event edits, reset, drag/resize/align/group, delete/cut, reparent, z-order, collection
editors, and adding children into it — inherited identities are added post-replay and aren't source-reproducible).
`SourceMetadata` becomes origin-aware (no synthesized Modifiers/GenerateMember/event-wiring for Inherited). Per-property
`ValueState {value|null|collection|unavailable}` + ReadDiagnostic — a throwing getter/converter → unavailable read-only
row, never a confirmed null, never the compiled value, never a whole-panel failure. `MetadataState {ok|unavailable}` so a
parse failure isn't shown as a confirmed negative.

**Describe fail-closed:** on failure — dispose the attempted graph, return the typed failure, host verifies token/gen,
clears/disables the panel ("Properties unavailable for this live-source preview"), sends `manip:{move:false,resize:false}`,
disables writes, optionally schedules a full render to reclassify. If that render returns compiledFallback, publish the
fallback canvas + disclosure FIRST, then load compiled describe. The old interpreted bitmap may stay visible but read-only;
compiled properties never appear under it.

**Avoid a 2nd rebuild:** `RenderInterpretedWithLayout(..., describeTargetId?)` optionally returns the selected target's
description from the SAME graph before teardown (atomic picture+panel after open / edit / drag / undo / structural edit).
Selection-only changes use the standalone describe endpoint; coalesce so ≤1 standalone interpreted describe is in flight.

## WRITE side (source transaction, then interpreted replay)

An interpreted edit is a two-phase SOURCE transaction, never "mutate then reconcile": webview gesture → capture
authority+snapshot → Roslyn source transformer produces the minimal updated buffer → recheck doc.rev+authority → commit
through the byte-local firewall → install `reconciling` (old bitmap view-only) → EngineApi builds fresh IR (default domain)
→ child constructs+replays+realizes+snapshots → host validates rev/hash/token/gen → atomically publish
canvas/layout/tray/authority/selected-description → dispose the graph. The existing `commit` firewall + revision checks
(designerEditor.ts:1136) stay authoritative.

**Gesture preview:** drag/resize uses the WEBVIEW's local transform as the immediate preview; on pointer-up, splice source
→ full interpreted render (reject/stale ⇒ snap back). Never mutate an engine instance to look responsive.

**Post-commit routing seam:** centralize the dozens of net48 branches behind one `refreshAfterSourceCommit(priorAuthority,
compiledMirror?, options?)`: modernSource→modern policy; net48Interpreted→ignore compiledMirror, full interpreted render;
net48CompiledFallback→run compiled mirror against the cached fallback, keep the reason; net48CompiledLegacy→compiled
mutation; reconciling/stale/none→full render or fail. Add a hard `live48` guard: if authority is interpreted, do NOT call
the compiled mutation (log an invariant violation, route to interpreted full render). `show48` STOPS assigning a generic
"compiled" mode (a live-mutated fallback stays `compiledFallback`).

**Coverage-loss transition:** if a committed source edit legitimately loses coverage — the edit stays committed+undoable;
publish the new compiledFallback canvas + reason; only THEN load compiled properties; subsequent edits use compiled mirrors
until interpretation succeeds again. An RPC crash/timeout ⇒ keep the old bitmap stale, editing disabled, retry/recover/undo,
never silently install a compiled canvas.

**Operation routing** (interpreted authority → every committed change = one fresh full replay, even events/Modifiers):
property set/reset, drag/move/resize, align/center/same-size/group, add visual/nonvisual, remove/cut, paste/duplicate,
reparent, z-order, string collections/arrays, columns/tree-nodes, ToolStrip item property + structural, image/resource
(fresh resx fingerprint), TableLayout cell, event wire/unwire, Modifiers/GenerateMember (origin-gated), undo/redo/revert.
Eligibility (target exists, CanEdit, supported) is checked BEFORE the transformer and AGAIN after awaited work.

**Tabs** = transient VIEW STATE, not a source edit: interpreted render emits tab-header hit regions
{hostIdentity,pageIdentity,headerBounds,selected,authorityId}; the host stores `selectedPageByTabHost[host]=page` in the
session, includes it in the next render request + token, and after replay validates host/page exist in Instances and the
page belongs to the host, applying the selected page via a NARROW allowlisted `TabControl`+`TabPage` adapter (vendor tabs
need explicit adapters, else disabled with a reason). A tab click = uncached interpreted rerender with a new view-state
fingerprint. Tab rename/add/delete stay source operations.

## Lifecycle / caching

Interpreted live-object cache capacity = **zero**. Full render and standalone describe each: create graph on STA → replay
→ apply view state → host/show/layout → (describe target if requested) → snapshot/marshal → dispose in `finally`. Edits
have no interpreted object to invalidate — a new source hash simply makes a new request; old descriptions fail their token
checks. The existing `_cache` stays compiled-only and is authoritative ONLY while the accepted canvas is
compiledFallback/legacy: on interpreted success, evict/dispose the compiled entry for that assembly/type; while interpreted
is active no compiled describe recreates it; undo/redo/revert under fallback discards the compiled instance before a new
fallback render. Safe optimizations before any object cache: inline selected description from the render graph; coalesce
selection describes; retain the published immutable `ComponentDesc` for `{authorityId, componentId}`; only if benchmarked,
a small IMMUTABLE DTO cache keyed by the full engine input token + component id (owns no controls/handles/timers). A live
interpreted object cache is a measured follow-up, NOT M4 (it carries timer/handle/vendor-state/DoEvents risks).

## Status semantics

Split `isCompiledPreview` into `pinsNet48Output` (true for interpreted AND fallback) and `isBuildBasedCanvas` (true only
for fallback/legacy). Refresh status when render mode changes, not only when engineKind changes.

## Slices (smallest-valuable-first; each independently shippable + tested + codex-reviewed)

1. **Thin vertical READ parity** — request-local interpreted describe scope in RenderWorker; `DescribeInterpretedComponent`
   on EngineApi; origin/logical-root/value-state DTO fields; origin-aware SourceMetadata; reuse CompiledDescriber's explicit
   sibling input. Host: typed render mode + `CanvasAuthority`; source/hash/token publication gates; route
   loadProps/loadItemProps/describeFor/manipFor/ref-revalidation through one describe router; clear/disable on interpreted
   describe failure. NOTE: the net48 test project doesn't compile-link RenderWorker/CompiledDescriber — extract the
   child-side helper into a testable unit or link it into Engine.Net48.UnitTests.csproj.
2. **Scalar property / reset / geometry WRITE parity** — optional selected description from the full interpreted render; host
   `refreshAfterSourceCommit`; route property set/reset, item property, drag/resize/align/group/batch; reconciling state;
   `live48` guard; `show48` stops inventing compiled mode. (Closes the first-edit canvas flip.)
3. **Structural control operations** — add/remove/cut/paste/duplicate/reparent/z-order stay on live source; layout/tray DTOs
   carry origin+editability; undo/redo conditional compiled discard; selection retention by identity.
4. **Collections / items / resources / metadata** — ToolStrip items, arrays, columns, tree nodes, images/resources
   (resx fingerprint in token), TableLayout, events, Modifiers — all through the common post-commit router; item identity
   via Instances+Origins; per-property unavailable states.
5. **Tabs + authority transitions + compiled-cache hygiene** — tab-header hit regions + allowlisted view-state; interpreted
   success evicts obsolete compiled live state; fallback carries LiveInstanceId; split pinsNet48Output/isBuildBasedCanvas.
6. **Race / lifecycle / performance hardening** — authority token on every message; ≤1 standalone describe in flight;
   latest-selection coalescing; disposal instrumentation; crash/domain-release invalidation; optional immutable DTO cache
   only if benchmarked (300-control interaction threshold).

## Acceptance criteria (M4 complete only when ALL hold)

Unsaved interpreted canvas value == panel value · interpreted reference candidates come exclusively from the interpreted
identity model · inherited identities visibly read-only · no property/reset/drag/add/remove/paste/collection/item/z-order
edit calls a compiled mutation while authority is interpreted · the first interpreted edit stays interpreted whenever the
updated source still fully covers · coverage loss → compiledFallback only through a disclosed accepted full render ·
describe failure disables the panel (never compiled values under interpreted) · save-without-build doesn't switch
authority · every response is rejected unless its authority/source/token matches the current canvas generation · every
interpreted render/describe graph is disposed after producing its DTO/snapshot · no new Roslyn / arbitrary value-execution
enters the child domain · the compiled fallback workflow keeps using its cached `LiveDesign` for both canvas and panel.

## Top correctness risks → controls (each pinned by a slice test)

Wrong panel value → canvas-bound authority + exact token, no interpreted→compiled describe fallback (S1). Wrong siblings →
Instances+Origins declared-current-source filter + alias rejection (S1). Inherited accidentally editable → origin crosses
all DTOs, host+engine both reject (S1/S3). Drag uses last-build geometry → describeFor+manipFor via the same authority
(S2). First edit flips to compiled → central post-commit router + hard live48 guard (S2). Source commits but picture never
reflects → reconciling + full replay + old bitmap view-only (S2). Unsupported edit silently changes mode → only an accepted
full render installs compiledFallback, always with reason (S2). Stale compiled instance reappears → cache authoritative
only during fallback, evict on interpreted success (S5). Resource-only edit reuses old interpretation → resx fingerprint in
token (S4). Root reports base type → explicit logical designed type/name (S1). Getter failure appears as null → per-property
ValueState=unavailable (S1). Source metadata lies → MetadataState + origin-aware application (S1/S4). Old async overwrites
current → renderSeq+doc.rev+sourceHash+engineInputToken+authorityId+selectionGen (S6). Security widens → Roslyn
default-domain-only, existing IR validation+allowlists, no general mutation endpoint (S1). Repeated describes leak Forms →
no graph cache, deterministic finally disposal (S1/S6).

## Slice 1 — implementation status (2026-07-20)

**DONE + green** (net10 128, net48 6, e2e PASS, webview 505): engine `RenderWorker.DescribeInterpretedComponent` /
`DescribeInterpretedOn` / `InterpretedParentOf` (identity-model target + current-source siblings + logical root, fail-closed
dispose), `EngineApi.DescribeInterpretedComponent` RPC + `--describe-interpreted` CLI, `engineClient.describeInterpretedComponent`,
and the host wiring — `loadProps` / `loadItemProps` / `describeFor` route to the interpreted describe when
`net48RenderMode === 'interpreted'`, with a null result leaving the panel unavailable (never compiled values) and disabling
move/resize. An independent codex review (round 1) found 9 issues; **fixed:** #1 host wiring (the panel now actually calls
the interpreted endpoint), #2 inherited target → null (require `Origins==DeclaredInCurrentSource`), #3 stale-base handshake
in describe, #4 `HostOffscreen` wrapper-Form leak on `Show()` throw (shared fix, also fixes the render path), #7
null-describe → `manip{move:false,resize:false}`, #9 `ShortName` handles the CLR nested `+` separator.

## Slice 2 — attempted "blanket guard" reverted; the per-operation router is required (2026-07-20)

A first cut tried the essential write-parity as a single "hard `live48` guard": under an interpreted canvas, return
`this.fullRender()` (re-interpret the committed source) instead of the compiled mutation, since all 20 net48 mutation
call sites funnel through `live48`. **An independent codex review proved this too broad and it was REVERTED** — the guard
falsely assumes every `live48` call follows a committed SOURCE edit. It is correct for source-backed control edits
(property/drag/remove/reset — codex CONFIRMED 9/11/12), but breaks three categories:
- **Tabs** (`tabClick`/`applyAddTab`): navigation/transient view state that does NOT commit source (and `AddTabPage`'s
  splice writes no selection) — the guard skips the compiled tab-select, so the clicked/added tab never opens.
- **ToolStrip item edits** (`applyItemEdit`/`resetItemFromGrid`): need `fullRender(skipReselect=true)`; the guard's plain
  `fullRender()` posts a control-select that clears the on-canvas item selection (pinned by a webview-e2e no-trailing-select
  test), which then mis-targets the next Delete.
- **Paste/Duplicate**: a loop of per-control `live48` calls — a mid-batch mode flip mirrors only part of one transaction.

**Then implemented correctly as a per-operation OPT-IN router (green: e2e PASS, webview 505).** `live48` gained an optional
`interp?: { skipReselect?: boolean }`: `if (interp && net48RenderMode === 'interpreted') return this.fullRender(interp.
skipReselect ?? false)`. A caller opts in ONLY when it is a committed source-backed edit whose net9 counterpart is a full
render; an unflagged caller keeps the compiled path (the pre-M4 behavior — never a NEW break). **Flagged** (interpreted →
re-interpret committed source): group move / align / resize / group-remove / single-remove / add-control / z-order (all
already `if(net48) live48; else fullRender`), and the property edit via `liveEdit48` — the CONTROL caller (`applyEdit`)
passes skipReselect=false, the ITEM caller (`applyItemEdit`) passes skipReselect=true so the on-canvas item highlight
survives (this is codex #3's contract, now satisfied). **Not flagged** (kept compiled — no new break; Slice 4/5): reset,
tree nodes, image list, string/grid/tree collections, ToolStrip structural, paste/duplicate (their per-control `live48`
loop ends in ONE trailing `fullRender` that re-interprets the whole committed batch), tab navigation (transient view
state). This closes codex's blanket-guard failures #1/#2/#3/#5 by construction (tabs & paste unflagged, items skipReselect).

**A SECOND codex review of the opt-in router found more (fixed):** (#1) Paste/Duplicate had NO trailing net48 `fullRender`
(it was only in the net9 `else`), so the "self-handles" assumption was wrong — added a single interpreted `fullRender`
under an interpreted canvas that SKIPS the per-control compiled adds (which flip mid-batch and can't reach a source-only
parent). (#2) N/W/NW/NE/SW resize goes through `applyEdits` (Location+Size), whose `live48` was unflagged — now flagged.
(#3) the CONTROL property edit's `skipReselect=false` broke `Visible=false` (the control leaves the layout → selection
snaps to the form → the hidden control's grid is dropped, unrecoverable) — `liveEdit48` now ALWAYS `skipReselect:true`
(matching the pre-M4 `show48`, which posted no control select; the trailing `loadProps(id)`/`loadItemProps` restores the
grid), which fixes both the control-visibility and the item-highlight cases.

**Flagged control-edit surface now** (extended after the review — all follow the codex-validated `liveEdit48` pattern:
a source-backed edit → `live48` helper after commit, net9 counterpart is `fullRender`/`patchOrRerender`, `skipReselect:true`
so the trailing `loadProps`/`loadItemProps` refreshes the grid while the webview keeps its selection): group move / align /
resize (SE via applyEdit, N/W via applyEdits) / group-remove / single-remove / add-control / z-order / control-property /
item-property / paste / duplicate / **string & grid collection editors (`liveCollection48`) / string-array (`liveStringArray48`)
/ tree nodes (`liveTreeNodes48`) / control-reset + item-reset (`liveReset48`)**. That is essentially the entire common edit
surface. **Then extended further (green):** the **image-list edit** (`setCompiledImageListLive`) is flagged the same way,
and the **ToolStrip STRUCTURAL edit** (`liveToolStrip48`) gets an interpreted short-circuit — under an interpreted canvas
it returns `fullRender(true)` (re-interpret the committed source, keep the item highlight) instead of running the
`listToolStripItems` field-id resolution + compiled reconcile (which could bail before `live48` and would flip to the
build — codex #4). The **undo-race** (codex #7) is closed: `rerenderFromDoc` bumps `renderSeq` BEFORE the stallable
`discardCompiledLive` await, so an in-flight render can't paint the now-undone picture during the wait.

**The ONE remaining edit-parity area is TABS** (tab click/navigation + tab-rename hit-test — codex #1/#2/#6): these are
transient VIEW STATE, not source edits, so they genuinely need the Slice-5 infrastructure — the interpreted render must
emit tab-header hit regions + accept a closed view-state DTO (selected page) in its input token, and a narrow
`TabControl`+`TabPage` adapter applies it. That's a coupled engine+host change, deliberately left for Slice 5.
**Also remaining (minor):** codex #4b item-selection edge cases (nested-submenu `closeSubmenu`, availability/overflow —
largely pre-existing), and #8 the `live48` boolean not distinguishing an accepted-fallback picture from one reflecting the
committed source (a contract nuance for the ToolStrip-ADD auto-reopen).
**Still deferred:** #4 item edit selection edge cases (nested-submenu `closeSubmenu`, availability/overflow re-resolution —
largely pre-existing, compiled `show48` also posts a layout); #6 tab-rename hit-test on compiled geometry (Slice 5); #7
undo-race (in-flight interpreted render vs discard); #8 boolean-vs-fallback semantics (Slice 6); reset/collections/toolstrip
re-interpretation (Slice 4). **Infra gap:** a net48 `DesignerSession` host-test harness — the interpreted host routing (this
slice AND Slice 1's describe wiring) is logic the current engine-level e2e / engine-free webview-e2e can't drive; the change
is tsc-verified + correct-by-construction per codex's spec across two review rounds, pending that harness.

**Deferred to later slices (documented, from the same review):** #5 an *unexpected* exception inside
`InterpretedRenderPlan.Plan` (post-construction, e.g. a vendor `GetFields` throw — the per-field body is already guarded)
can strand the constructed root before the caller assigns `plan`; shared with the render path — fix by having `Plan`
own construction+teardown or return the root on a `try` boundary (S1 hardening / S6). #6 the describe response is not bound
to the source/render generation (only `selectionGen`), so a slow describe can overwrite a newer one — the `engineInputToken`
+ authority publication gate (§Canvas authority) closes it in **S6** (and partially S2's reconciling state). #8
reverse-identity aliases (two inherited field names → one object) aren't rejected by `BuildIdentityModel` — an inherited-only
edge, largely moot now that #2 excludes inherited targets; revisit if inherited describe is added.

## M4 overall status (2026-07-20, updated)

**Implementation functionally complete + acceptance-proven green.** Slice 1 (read) and Slice 2 (write — the whole common
edit surface: property/reset/geometry/drag/align/group/add/remove/z-order/reparent/paste/duplicate + collections/string-arrays/
tree-nodes/columns/image-list + ToolStrip-structural short-circuit + undo-race) are DONE. Slice 5 (tabs + view-state) is DONE
and directly e2e-proven (the `interpreted tab view-state` leg: default page + `tabControl1=tabPage2` override both stay
interpreted; bogus override is a safe no-op). S3/S4 operations route through the per-operation post-commit router.
Full suite green: net10 xUnit 128/0, net48 xUnit 6/0, tsc, l10n (7 locales), webview-e2e 505/0, e2e PASS (interpreted-describe,
tab view-state, vendor-corpus, all interpreter legs).

**Hardening + harness DONE (2026-07-20, codex-reviewed):**
- #5 DONE — `InterpretedRenderPlan.Plan` now wraps `Execute` and returns a fallback CARRYING `Root` (all three callers'
  finally dispose it: RenderInterpretedWithLayout, DescribeInterpretedComponent, HitTestInterpretedTab) so an unexpected
  executor throw can't strand the constructed Form; plus a targeted guard on the `BuildIdentityModel` `GetFields()`
  enumeration so a pathological vendor type is skipped, not fatal.
- #6 DONE — `loadProps` + `loadItemProps` bind the describe response to the SOURCE revision `doc.rev` (bumps on
  commit/undo/load), captured synchronously right after the source is sampled. **codex caught** that an earlier
  `renderSeq` binding over-rejected: a tab-header click's `skipReselect` `fullRender` bumps `renderSeq` (a VIEW-STATE
  render, no source change) and would discard the accompanying selection's describe, leaving the panel stale. `doc.rev`
  is immune to view-state renders — fixed.
- Host-test harness DONE — the identity-model resolution was extracted VERBATIM into shared `InterpretedDescribeResolver`
  (RenderWorker delegates to it, then does the net48-only CompiledDescriber step). 5 net10 white-box tests + 1 net48
  parity test pin root→logical-name, current-source→siblings, inherited→null, unknown→null, and the nested-parent case.
  **codex caught** a pre-existing `ParentOf` bug the extraction faithfully preserved: it scanned merged instances without
  checking `Origins`, so a current-source child reparented under an INHERITED container (a base `OnControlAdded`) reported
  the inherited panel's name as its parent. Fixed to filter `DeclaredInCurrentSource` (skip inherited ancestors to the
  logical root) + a test reproducing the exact scenario.
- #8 DONE — the interpreted ToolStrip-ADD auto-reopen now arms only on interpreted-SUCCESS (`fullRender && renderMode ===
  'interpreted'`); an add that costs coverage (fallback to a forest lacking the item) no longer reopens a stale flyout.
- S6 perf DECIDED — the optional immutable DTO cache is gated on a benchmark (the 300-control interaction threshold).
  `perf:baseline` shows warm median 83.6 ms (budget 1000), P95 772.7 ms (budget 2500), startup 697 ms (budget 15000) —
  comfortable headroom, so the cache is NOT needed at current scale. Revisit only if a real large form pushes P95 past
  budget. The remaining S6 token/authority gates for the describe race are closed by #6 (`doc.rev` binding).

**Still remaining (minor / user-gated):**
- Minor edge #4b item-selection (nested-submenu `closeSubmenu` / availability / overflow) — assessed and LEFT as a
  documented known-minor: no concrete repro, largely pre-existing, in intricate `designer.js` interaction code heavily
  covered by green webview-e2e; a speculative rewrite would risk regression for marginal value. Revisit on a concrete bug.

**Plan CLOSURE (1.0 GO) is structurally user-gated — not achievable by the assistant alone:**
- M6 fallback-rate gate: measure interpreted-vs-compiledFallback rate over a real `.Designer.cs` corpus and confirm it is
  under the acceptable threshold (the threshold is the maintainer's call).
- DevExpress real-vendor certification: needs a licensed DevExpress install; the FakeVendor corpus proves the pattern but is
  not a substitute for the real control set.
- Final GO sign-off: the maintainer's decision.

## Release GO checklist (executable hand-off for the user-gated closure)

The implementation + hardening are complete and green. Three steps remain, all requiring the maintainer's environment/decision:

1. **M6 fallback-rate gate — mechanism NOW EXISTS, run it on your corpus.** The engine ships `--coverage-report`:
   ```
   dotnet run --project engine -c Release -- --coverage-report <dir-of-.Designer.cs> [--min-rate <pct>]
   ```
   It measures the source-coverage interpreted-vs-fallback rate (the dominant, engine-agnostic fallback driver) and
   exits non-zero below `--min-rate`, so it is a CI/release gate. Baselines: `engine/samples` 88.2% (30/34; the 4
   fallbacks are coverage gaps incl. the *deliberately* fail-closed LocalizableForm + ImageListForm), `samples` 100%,
   `fixtures` 100% (FakeVendor interprets). `CoverageGateTests` pins a ≥80% floor on the sample corpus in CI.
   **You do:** point it at a representative corpus of your real `.Designer.cs` forms (including DevExpress ones), pick an
   acceptable threshold, and confirm the rate clears it. Runtime fallbacks (a real vendor ctor that throws, a stale
   base) are only observable by rendering against the actual build — measure those by opening the forms in the extension
   and checking the render mode / "last build" disclosure on your DevExpress corpus.

2. **DevExpress real-vendor certification.** The FakeVendor corpus proves the interpreter reproduces the DevExpress
   *patterns* (Appearance sub-object property chains, ISupportInitialize controls) with geometry parity, but is not a
   substitute for the licensed control set. **You do:** with a licensed DevExpress install, open a handful of real
   DevExpress forms in the extension and confirm they render INTERPRETED with parity to the compiled build (or fall back
   with a disclosed reason — never a silent mis-render). This is the M5/M6 real-vendor confidence step.

3. **Final GO sign-off.** With (1) + (2) passing and the full suite green (net10 xUnit, net48 xUnit, tsc, l10n, build,
   webview-e2e, e2e), the 1.0 release is the maintainer's call.
