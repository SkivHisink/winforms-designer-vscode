# ADR 0001 — net48 engine moves to live-source interpretation (VS model)

- **Status:** Accepted (2026-07-20)
- **Deciders:** maintainer (SkivHisink); independent architecture review by codex (gpt-5.6-terra) —
  verdict **APPROVE-WITH-CHANGES**, all mandatory changes folded into the plan below (v2).
- **Context:** v1.0.0 passed a 4-round adversarial audit (GO) with the .NET Framework 4.8 engine labeled
  *Experimental*: it renders a compiled instance of the last build, not the live buffer. The maintainer decided the
  release waits until that reason is removed — the engine must become genuinely stable, not relabeled.
- **Decision:** adopt the Visual Studio designer model on net48 — parse `InitializeComponent` (never execute it) in
  the engine's default AppDomain, marshal a closed/versioned/bounded statement IR into the render child AppDomain,
  instantiate the **base type** as root and **compiled** control types for children, replay statements under
  child-side runtime validation. The compiled-instance render remains as a per-form disclosed **fallback** and as an
  isolated hash-matched **differential comparator**. Release gate is quantitative (fallback-rate) with a two-tier
  support matrix.
- **Consequences:** ~16–24 weeks (M-1…M6); net9 production cutover to the shared IR pipeline happens after this
  release (shadow mode only until then); pinning/release/recycle machinery survives; vendor design-time hosting
  remains a permanent non-goal (VS-only SDK EULA).
- **Evidence:** five subsystem maps under `docs/adr/evidence/net48-stable/` (corrections in plan §9); codex review
  transcript in session task `bepm1iiwp`.

The accepted plan (v2, verbatim) follows.

---

# net48 → Stable: live-source interpretation on the .NET Framework engine — v2

**Goal.** Remove the *reason* for the "Experimental" label on the .NET Framework 4.8 engine: make it render the
**live buffer** the way Visual Studio's own designer does — parse `InitializeComponent` (never execute it),
instantiate the **base type** as root, construct **compiled** control types, replay statements — with the current
compiled-instance render retained as a per-form **fallback** (disclosed) and as an isolated **differential
comparator** for the interpreter.

v1 written 2026-07-20 from five subsystem maps (`docs/maps/net48-stable/map-*.json` — see CORRECTIONS below).
**v2 same day: amended per codex (gpt-5.6-terra) architecture review — verdict APPROVE-WITH-CHANGES, proceed with
M-1 → M0 after these amendments. This v2 incorporates every mandatory change.** Full review: session task
`bepm1iiwp`.

---

## 0. Codex verdict summary (what changed v1 → v2)

Approved: default-domain Roslyn front-end → closed statement IR → child-domain executor; base-type root (VS model);
hybrid with compiled fallback; rejected alternatives (pinned Roslyn in child, parse-only second AppDomain,
out-of-process render — the last is a possible future escalation only).

Mandatory changes, all folded in below:
1. **BLOCKER:** no live BinaryFormatter `.resx` materialization on the interpreted path — ever.
2. Versioned, bounded, **closed** IR with parser-side structural AND child-side runtime validation.
3. Truthful siting (`DesignMode=true`), real `BeginInit/EndInit`, construction safety, and security-negative tests
   move **into M0/M1** (not M5).
4. Hybrid identity model — inherited/base component identities preserved; `FieldNames` is NOT replaced wholesale.
5. Compiled render = isolated **differential comparator** with exact source/build hash matching — not "ground truth",
   not auto-run in production, not a fallback trigger.
6. Host models **two axes**: `engineKind` × per-result `renderMode`.
7. Live-mirror RPCs are **retained for compiled fallback** (they are required behavior there), deleted in interpreted
   mode only where perf evidence doesn't justify them.
8. Quantitative **fallback-rate release gate** + materially broader vendor/project corpus.
9. Plan/ADR/evidence promoted to **tracked** paths (docs/plans/ and docs/maps/ are gitignored — an M-1 commit would
   NOT preserve them).
10. Estimate: **16–24 weeks**; net9 production cutover is OFF the release critical path (shadow mode only).

## 1. Ground truth (v1 facts that survived review)

- **VS-classic model (canonical MS source):** the designer never executes the designed form's ctor/IC; it
  instantiates the form's **base class** as root, parses IC, replays statements onto real compiled child-control
  instances. DevExpress has rendered under this model in VS forever. VS's OOP designer (net6+) = out-of-process
  server on the project's runtime — precedent for our two-engine split; its SDK is VS-only by EULA → vendor
  design-time hosting stays a permanent non-goal.
- **net9 engine is already a VS-style interpreter** (~18.2k LOC; interpreter core ~1.1k LOC ~95% portable; the
  splice-editor family ~7k LOC pure Roslyn text logic). Only hard net10-only piece: collectible ALC → AppDomain
  analogue exists.
- **Roslyn stays OUT of the render child domain** — as a *binding-policy decision* (codex correction, not a CLR
  impossibility): `ChildDomainConfig` synthesizes unbounded redirects unified on the USER's versions; loading our
  Roslyn graph under that policy is not robust. The RPC stack (StreamJsonRpc/Newtonsoft) runs in the DEFAULT domain —
  it does not disprove this. Add a probe test: after an interpreted render, no `Microsoft.CodeAnalysis*` assembly is
  loaded in the child.
- **What survives wholesale:** RPC/pipe/CLI shell, DomainManager + ChildDomainConfig + release/leak quarantine
  (pinning does NOT go away), StaDispatcher, Snapshot pipeline, CompiledDescriber, toolbox/vendor-smart-tags/
  ImageListSerializer (audit — see BLOCKER), FormClassResolver identity.
- **Trust model, stated explicitly:** compiled component code is **trusted-to-execute** (ctors, accessors,
  collection/init methods, painting, TypeDescriptor code from built project/vendor assemblies necessarily run).
  The source boundary prevents arbitrary C# *expression* execution; it does not sandbox compiled controls.

## 2. Security architecture (codex findings 1–3 — load-bearing)

### 2.1 BLOCKER — no live BinaryFormatter on the interpreted path
The v1 "net48 bonus: binary-resx via live BinaryFormatter" is **withdrawn**. The live sibling `.resx` is
repository-controlled input; BinaryFormatter cannot be made safe for untrusted input (MS guidance), and the modern
engine's `DesignerResx` already refuses binary/SOAP/`ResXFileRef` nodes *before* `GetValue` — the interpreted net48
resolver keeps exactly those refusal semantics. A form requiring such a resource gets a deterministic
`unsafeBinaryResource` reason → disclosed compiled fallback. If ImageListStreamer decoding is ever indispensable
live, it needs a format-specific non-BinaryFormatter decoder — a full-trust child AppDomain is NOT a sandbox.
**Pre-M6 audit item:** the existing `DeserializeImageList` RPC enumerates `ResXResourceReader` over caller bytes
(deserialization happens during enumeration, before the type check) — currently user-triggered; must be audited and
hardened before any path makes it automatic.

### 2.2 Parser/executor validation split
- **Default domain (parser):** syntax-only. Parses into a closed semantic vocabulary; validates identifiers,
  grammar, literal/value IR, operation shape, bounds, and the exact built-in allowlists (the 3 Eval lists) — WITHOUT
  loading user assemblies (loading them there would pin them in a non-unloadable domain and bypass the release
  lifecycle).
- **Child domain (executor):** runtime type resolution + semantic validation immediately before execution, under the
  project's binding policy. Mandatory checks: target is root or an instance THIS IR created; type context-appropriate
  and assignable; property paths are identifier-only and resolve through real instance properties; control-add
  targets a real `ControlCollection`; collection-add targets a modeled collection shape; extender ops correspond to a
  real extender property (not any `Set*` method); init calls target an existing `ISupportInitialize` via interface
  dispatch; every known node has valid fields/values/ordering/cardinality. "Unknown node kinds refused" is necessary
  but NOT sufficient.
- **IR = specific capabilities, not generic Invoke:** `ConstructComponent`, `SetProperty`, `AddControl`,
  `AddCollectionItem`, `SetExtenderProperty`, `BeginInit`, `EndInit`, `ResolveSafeResource`, `WireEvent` (capture).

### 2.3 IR transport contract
Sealed DTOs (or a small versioned binary envelope); enums/bounded numbers/booleans/strings/arrays of known IR
records ONLY; no `object`/`Type`/`MemberInfo`/delegates/syntax nodes/`ISerializable`/serialization callbacks; schema
versioning; bounds on source length, IR bytes, statement count, nesting depth, path length, array/string length;
**semantic values, never expression strings the child re-parses**; verbatim-preservation text stays in the default
domain (never sent to the renderer). Negative tests: forge known-kind nodes, unknown nodes, invalid enums,
excessive graphs, invalid paths/init targets/sequences directly at the executor and prove rejection **without the
side-effect canary firing**.

## 3. Fidelity architecture (codex findings 4–7, 9)

### 3.1 Hybrid identity model (NOT wholesale FieldNames replacement)
`DesignedTypeName` (logical class being designed) ≠ `RuntimeRootType` (instantiated immediate base) — carried
separately (Snapshot's root naming must use the logical identity). Identity table = merged: entries seeded from
inherited compiled fields/sites (reflection walk over base types — the current map's role) + entries for IR-created
current-source components; origin metadata `root | inherited | declaredInCurrentSource`; collision/hiding detection
fail-closed. **Inherited controls are marked inherited/LOCKED** unless persistence to the owning base designer file
is implemented (a private base field cannot legally receive `this.baseButton.X = …` in the derived file).
Stale-type handshake: if live source changed the declared base but the assembly still holds the old one →
`baseTypeChangedRebuildRequired`, never replay onto a stale compiled base.

### 3.2 Root construction
Instantiate the exact immediate compiled base (VS model). Consequences accepted & documented: most-derived ctor/IC
never run (own-ctor/Load visuals disappear — release notes); concrete form over **abstract base** → named refusal
(VS parity); **abstract designed form over concrete base stays designable**; unconstructible base (required args) →
deterministic named refusal/fallback. The current `CreateRoot` non-public/all-optional-ctor policy is NOT
transferred blindly — base-ctor acceptance gets its own VS-oriented matrix in M1.

### 3.3 Real `BeginInit`/`EndInit` (hard semantics)
Required on net48 interpreted path: exact source order; interface dispatch only; zero args; targets must exist and
implement the real interface; pair/order integrity prevalidated; no invented pairs; unmatched call / wrong target /
Begin-End exception = **hard interpreted-render failure → fallback**, with the partially built graph disposed —
never Snapshot a half-initialized vendor tree. net9 adopts real replay only with its deliberate IR cutover (post-
release) — no one-off behavior fork.

### 3.4 Siting — in M1, minimal and truthful (not M5, not host-lite)
Real design `IContainer`; narrow truthful `ISite` (stable `Site.Name`, `Site.Container`, `DesignMode=true`,
tightly allowlisted `GetService`); deterministic removal/disposal; siting immediately after construction, before
BeginInit/property replay/handle creation/paint. NO general fake `IDesignerHost` (vendor code may detect it and
assume transactions/selection/serialization services we don't have) — services expand individually on corpus
evidence. Documented limits: `DesignMode` is false inside ctors (site can't precede construction); privately created
nested controls may stay unsited; `ISite.DesignMode=true` ≠ `LicenseManager.UsageMode==Designtime`.

### 3.5 Differential comparator (renamed from "oracle")
- Release-gating comparisons ONLY against assemblies **freshly built from the exact sources/resources being
  compared** — store a build manifest (hashes of .Designer.cs, code-behind/base sources, .resx, config, deps,
  culture, DPI, output). `BuildId` (mtime:length) is NOT sufficient.
- Interpreted and compiled legs run in **separate fresh AppDomains** (static skin/font/license state must not
  contaminate); static-sensitive fixtures repeat in reverse order.
- NOT auto-run in production (the compiled leg executes most-derived ctor + Load/Shown/timers via Show+pump).
- Pixel diff is a **test/diagnostic signal, never a fallback trigger** — fallback follows IR coverage/execution
  integrity only.
- Gate = zero **unexplained** divergence. Classification: `equivalent` / `expectedVsModelDelta` (most-derived ctor,
  root Load/Shown, derived statics — requires declared evidence, not a waiver) / `unsupportedIr` (counts as
  fallback) / `interpreterDefect` / `environmentMismatch` / `nondeterministicOrContaminated` / `resourceMismatch`.

### 3.6 Vendor construct taxonomy (drives FakeVendor)
Expected-equal: public TypeDescriptor property chains (Appearance/Options.*) with safe-IR values; `IComponent`
graphs (layout items, grid columns, repository items) whose collections implement modeled interfaces; isolated
`DefaultLookAndFeel`-style components configured in IC. Likely-fallback: custom non-`IList` collections,
specialized AddRange, inline non-`IComponent` vendor value ctors, repository buttons, custom layout descriptors
(vendor object construction is NOT opened up — security model wins). Expected-VS-model-delta: `UserLookAndFeel.
Default`/`WindowsFormsSettings`/fonts/skins applied in `Program.Main`/own ctor/Load. Environmental: license
failures, async skins, DPI/font substitution. FakeVendor declares each fixture's expected class explicitly.

## 4. Host contract (codex finding 10)

Two independent axes: `engineKind: modern | net48` × `renderMode: interpreted | compiledFallback` (per successful
render result, generation-checked; cleared/unknown on failed/unbuilt render). Machine-readable fallback reason
codes. Banner/status badge/undo behavior/live-edit routing/diagnostics all driven from the last successful result's
mode; mode-change refreshes status even when engineKind didn't change. Transition tests: interpreted → unsupported
source → fallback → supported → interpreted, incl. superseded renders, undo, crash, recovery.

Correction of v1: NOT all ~45 net48 branches are post-commit picture mirrors — toolbox enumeration, compiled
describe/vendor tags, tab ops, pin/release and process lifecycle are runtime-ENGINE concerns that survive
interpretation; only the picture-mirror subset collapses behind `renderMode`.

**Live-mirror RPC policy (fixes the v1 M3/M4 contradiction):** compiled fallback RETAINS today's live-mirror RPCs
byte-for-byte (they are required behavior — splice commits, then live48 refreshes the picture; deleting them would
make every fallback edit stale-until-rebuild). Interpreted mode: off by default; an incremental path is kept only
if the 300-control perf gate proves it, always behind source-first commit + generation checks + full-replay
recovery. Every RPC classified by consumer before any deletion.

## 5. Milestones (codex-revised; ~16–24 weeks)

| M | Content | Est |
|---|---------|----:|
| **M-1** | Commit the audited 1.0-GO baseline (user action). **Promote this plan to a TRACKED path** (docs/plans/ and docs/maps/ are gitignored — `git check-ignore` confirmed): add a tracked ADR, e.g. `docs/adr/0001-net48-live-source-interpretation.md` + tracked copies of the evidence maps; internal tag; immutable CI artifact + SHA-256 | immediate |
| **M0** | Closed/versioned/bounded IR + syntax-only parser + shared security policy (allowlists re-pinned in shared core) + malformed-IR negative tests (side-effect canary) + net48 unit-test scaffolding + **dark net9 differential path** (IR runs in shadow on net9, current executor stays authoritative). Cleanup: stale Program.cs "M1 render-first" comment; stale Dtos.cs id-lock comments; e2e fixture-staleness array missing NotifyIconForm.Designer.cs | 3–4 wks |
| **M1** | Child executor: runtime validation (§2.2), base/inherited hybrid identity + logical-type identity (§3.1–3.2), **siting** (§3.4), **real init replay** (§3.3), safe resources (§2.1), stale-type handshake, per-form mode classifier + named fallback reasons. Exit: the **7** linked Net48CtxFixture designer sources render interpreted as NAMED cases — direct-root fixtures match net9 geometry; `DerivedForm` matches the VS/base-root model (`baseButton`+`derivedButton` — deliberately ≠ net9's current drop-base behavior, recorded as expected-divergence metadata); unsaved-buffer render proven | 4–6 wks |
| **M2** | Isolated hash-matched differential comparator (§3.5) + FakeVendor per taxonomy (§3.6) + broader corpus (§6) + real-vendor certification manifest + 300-control perf | 4–6 wks (fixtures overlap M1) |
| **M3** | Two-axis host mode semantics (§4): banner/status transitions, fallback routing, capability plumbing, formNotice matrix re-pinned | 2–3 wks |
| **M4** | Interpreted edit parity (splice → re-render); RPC classification per §4 policy; tab ops: net9 legs implemented, net48-only guards lifted in interpreted mode | 2–3 wks |
| **M5** | REPEAT adversarial security review (IR/executor), licensing/lifecycle soak (multi-form, shared-bin, rebuild/release, crash/recycle, memory), service-expansion audit for the site | 2–4 wks |
| **M6** | Fallback-rate gate (§7), docs/label two-tier matrix, 7-locale l10n, final full codex GO protocol | 1–2 wks |

net9 production cutover to the IR pipeline: **after** this release (shadow/differential during M0–M5 keeps the
security policy single-sourced); a pre-release cutover would add 2–4 wks and risk the already-stable engine.

## 6. Corpus (codex finding 12 — required dimensions)

FakeVendor (MIT, in-repo, CI) per §3.6 taxonomy + net48 unit project + env-gated real-vendor leg (DevExpress/PGMUI;
**emits an archived redacted certification manifest**: vendor/version, project/form counts, source/build hashes,
outcome, fallback reason, geometry result, pixel metric, timing, environment — not just "green on the dev machine").
Additional required dimensions: SDK-style net48 **WinExe**; **old-style/non-SDK csproj** (TargetFrameworkVersion,
packages.config, classic output paths); .exe.config & library-beside-host config selection; multi-form/multi-project
sharing one child domain; multi-level visual inheritance + independently rebuilt base; concrete-over-abstract and
abstract-over-concrete roots; non-public/optional/required base ctors; Form/UserControl/XtraForm-like/
XtraUserControl-like roots; AnyCPU + x64; **x86 as explicit deterministic unsupported-path test**; licenses.licx /
embedded .licenses / permissive & rejecting fake license providers; neutral + satellite resx, Icon/Image/ImageList,
missing/corrupt/unsafe binary nodes; Localizable=true as pinned named unsupported tier; multiple vendor
generations; binding-redirect collision fixtures (System.Memory etc.); DPI 100/125/150/200%, font/theme/culture,
repeated-render determinism; same-simple-name types across assemblies; 300-control nested layouts.

## 7. Release gate (codex finding 11 — quantitative)

- Target: ≤ **2%** form-level fallback on the representative real-vendor/LOB corpus (~200 forms, several
  independent apps, multiple vendor generations).
- Hard NO-SHIP: > **5%** fallback, or one-sided 95% CI upper bound ≥ 5%; any major vendor cohort > **10%**;
  > **10%** of sampled projects contain a fallback form.
- **Zero** fallback on the canonical framework + FakeVendor contract corpus.
- Any silent/unnamed/nondeterministic/materially-wrong interpreted render = NO-SHIP regardless of rate.
- Every non-full-IR or init/execution failure counts as fallback; denominator = forms opened.
- Support matrix becomes TWO tiers: "net48 live-source interpreted — **Stable**" / "compiled last-build
  compatibility fallback — degraded, disclosed per form". No single unconditional "Stable" cell.
- Plus codex's full M6 NO-SHIP list (session task `bepm1iiwp`, "I would say NO-SHIP at M6 if…") — adopted verbatim
  as the M6 checklist.

## 8. What stays weaker than modern/VS (documented, not hidden)

Needs a compatible compiled type graph (type/base changes → rebuild); compiled ctors/accessors still execute
(trusted-to-execute model); DesignMode false inside ctors; vendor designers/action-lists/UITypeEditors/VS SDK out of
scope; ApplyResources localization separate; x86 unsupported (explicit error); unsafe binary live resources →
fallback; in-place loading pins outputs until release/unload; licensing context may differ from VS; DrawToBitmap
capture-class limits; some vendor IC constructs remain outside the safe IR vocabulary → disclosed fallback.

## 9. Map corrections (codex finding H — 9 wrong/misleading facts)

The maps in `docs/maps/net48-stable/` are evidence, corrected as follows: (1) LiveInstanceId/BuildId are DIAGNOSTIC
only — the host divergence lock was descoped (map-net48-engine overstates; Dtos.cs comments stale). (2) StreamJsonRpc/
Newtonsoft run in the DEFAULT domain — they don't prove child-redirect survival (conclusion unchanged: keep Roslyn
out). (3) The 3 Eval allowlists are not the whole security model (construction/accessors/collections/extenders/
resources/save-gates are also security surface). (4) NOT all net48 host branches are post-commit mirrors. (5) The
net48 fixture links **7** designer sources, not 8. (6) ensureNet48Fixture's staleness array omits
NotifyIconForm.Designer.cs (real bug — M0 cleanup). (7) FieldNames→interpreter-table wholesale replacement invalid —
hybrid identity required. (8) S5 proves compiled vendor rendering, NOT parse/replay init fidelity. (9) "SourceMetadata
entirely subsumed" true only for current-source statements — inherited/fallback still need source-ownership metadata.

## 10. Non-goals (unchanged)

Vendor design-time hosting (VS-only SDK EULA), full ApplyResources workflow, x86 variant, Linux/macOS.

## 11. Post-implementation independent review (2026-07-20)

After the whole testable interpreter core (M0 + M1 logic + render + host routing + M2 comparator/corpus + M5 soak/
licensing + broad IR coverage) was green, it was put through **two independent adversarial reviews**: a Claude 5-lens
workflow (8/8 findings confirmed) and codex/gpt-5.6 (24 findings, incl. **2 CRITICAL the Claude self-review missed** —
the "run codex independently" lesson). 32 findings total; the label "Experimental" was honest.

**Fixed + verified green** (net10 xUnit 125, net48 6, both engines build 0/0, tsc, e2e + webview-e2e PASS; 19 new pinning
tests):

- **[CRITICAL] Allowlist FullName-only bypass** — the three value gates matched `Type.FullName` only, and the executor
  resolves via a host that probes the user assembly first, so a project shadow `System.Drawing.Color` with a
  side-effecting getter could run on preview-open. Fixed: `IsTrustedFrameworkType` anchors on the actually-loaded
  framework assemblies (a user cannot forge an MS-signed assembly); AND'd into all three `Is*Allowed(Type)`.
- **[CRITICAL] Forged-doc crash before validation** — `RenderInterpretedWithLayout` had no encompassing try/catch, so a
  forged/edge document escaped as a hard RPC error. Fixed: the whole post-load body is `try/catch → CompiledFallback` +
  `finally → dispose(form, partial root, container)` — also closes the per-render HWND/GDI leak (form was shown, never
  disposed) and the sited-container leak.
- **[HIGH] Extender capability confusion** — `IrSetExtender` invoked any 2-arg `Set*`; now requires a `[ProvideProperty]`
  advertised name + `CanExtend`.
- **[HIGH] Silent-wrong-render class → honest fallback** — compound assignment mistaken for event wiring, named ctor/
  factory args replayed positionally, multi/zero-arg `Add`, non-canonical layout calls, vendor `*.TreeNode`, hex/binary
  literals, unresolved cast/array element types, and refused resources returning null now each fall back (disclosed)
  instead of rendering something wrong. Refused resources carry the precise `unsafeBinaryResource` reason.
- **[MED/LOW] DoS + robustness** — a whole-document aggregate string budget (threaded through `IrValidate` over every
  string-bearing node: values, type names, resource keys, tree-node names), a 32 MiB sibling `.resx` size cap, and
  forged-null guards (`UnrepresentableReasons`, `BaseTypeSyntaxName`, `TargetName`, root `IrComponentRef.Name`).
- **[re-review regressions, caught by the re-review + fixed]** the strict cast/array fixes rejected the classic VS
  `Font(..., ((byte)(0)))` charset arg and `new string[]{...}` (C# keyword aliases don't resolve as reflection names) →
  keyword aliases now normalize to CLR FullName; the layout-call receiver gate over-Gapped two-hop
  `splitContainer1.Panel1.SuspendLayout()` (every populated SplitContainer/ToolStripContainer panel) → relaxed to any
  `this`/field-rooted receiver while keeping the arg-shape guard; the aggregate budget initially missed resource keys/
  type names → now counts them.
- **codex #5 — vendor child-type resolution (HIGH for coverage) — FIXED.** `AssemblyIrHost.ResolveType` previously
  searched only a frozen 6-assembly array + `Type.GetType`, so a control from a referenced vendor/sibling assembly (e.g.
  `DevExpress.XtraEditors.SimpleButton`) never resolved and the form fell back on *every* render — the main reason real
  vendor forms didn't interpret. Now it also force-loads the probe assemblies' references (once, best-effort, via the
  child domain's probe handler) and scans everything loaded in the AppDomain. This does NOT widen the value-security
  boundary (the executor still re-gates static reads/factories/inline ctors by `IsTrustedFrameworkType`); broad
  resolution serves only component/control construction, the trusted-to-execute path. Validated by unit test; end-to-end
  interpret-rate on a real DevExpress install still needs the user's environment.

**Deferred (documented, not release-blocking for the *fail-closed* bar, but real work):**

- **codex #1 — cross-AppDomain `[Serializable]` transport** trusts the in-process producer; not reachable from hostile
  source today (the default-domain builder emits only known leaves) but a `SerializationBinder` restricting the stream to
  the closed node set would harden it. The aggregate budget bounds downstream work, not the deserialization allocation
  itself.
- **codex #7** split-partial base handshake (base declared in the non-designer `.cs` partial → `BaseTypeSyntaxName` empty
  → a stale compiled base can be used silently until rebuild); **#8** the interpreted root is not sited
  (`DesignMode==false` on the root only — siting a `Show()`n root has real behavioral risk, and the impact is contrived);
  **#23** `--compare` shares one AppDomain (static state can skew equivalence); **#24** net48 Snapshot coverage counters
  report control counts, not source-statement coverage (host currently ignores them).
- **codex #15 — FIXED.** `ComponentResourceManager(typeof(OtherForm))` would have read the current form's sibling `.resx`;
  the builder now only registers a manager whose `typeof(X)` target IS this form, so a foreign manager's GetString/
  GetObject falls back honestly (VS canonically emits `typeof(ThisForm)`, so no normal form over-Gaps).

**Blocked on the user's environment / sign-off (unchanged from §7):** real-vendor DevExpress certification + the
quantitative fallback-rate release gate (§8), and the M6 label removal + full GO audit.

### 11.1 M4 (edit parity) — scoped, with the key constraint identified (not yet implemented)

For an interpreted net48 form the canvas shows the interpreted (live-source) picture, but `describe` and live-edit still
read/mutate the COMPILED last-build instance — so on an UNSAVED source edit the property panel can disagree with the
canvas until the next full render (data-safety is intact — the byte-local firewall owns source — this is a fidelity/UX
gap). Closing it is M4. The concrete slices and the constraint found while scoping:

- **Read-side (describe parity).** A new isolated `DescribeInterpreted` path: build the interpreted instance
  (`InterpretedRenderPlan.Plan`, reuse the render lifecycle + fail-closed dispose — do NOT refactor the hardened
  `RenderInterpretedWithLayout`), then describe the target. **KEY CONSTRAINT (found while scoping):** `DescribeOn`
  enumerates a component's field-backed siblings for the reference dropdown + target resolution via
  `live.Type.GetFields(DeclaredOnly)` on the runtime root type. That is correct for the compiled instance (every field is
  on the runtime type) but WRONG for the interpreted instance, whose root is the immediate BASE type — the derived
  source's fields (`button1`, …) exist only in `exec.Instances` / the `FieldNames` map (hybrid identity), not as
  reflectable fields on the base type. So interpreted describe needs a hybrid-identity-aware sibling enumeration
  (iterate `FieldNames` instead of reflecting the base type), and property values come from the executor-set state.
- **Write-side (edit parity).** Route live edits to the interpreted instance and reflect them, keeping the byte-local
  source splice authoritative (the interpreted picture must re-derive from source, so a live edit is a preview only until
  committed). Interacts with the deliberately-uncached interpreted render (it reflects source each call) — an edit
  session needs a short-lived cached interpreted instance keyed by (assembly, type, source hash) with invalidation on
  source change.
- This is a correctness-sensitive milestone (a wrong sibling set = wrong reference dropdown / wrong edit target), so it
  warrants its own implementation pass + independent review, not a tail-of-session patch.
